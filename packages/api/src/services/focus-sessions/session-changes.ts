/**
 * listSessionChanges — the session CHANGE FEED read: what happened on a session
 * since a cursor, as TYPED events. What `waitForSessionChanges` (MCP
 * `synap_wait_for_answer` with `events`, Hub `GET /focus-sessions/:id/answers/
 * wait?events=…`) long-polls on, so a client the pod cannot wake (a Claude Code
 * session bound by synap-bridge) learns of a change in one call instead of
 * re-reading the whole session and diffing it. The POD derives the events —
 * no client re-implements "what counts as a change".
 *
 * EVENT KINDS (`SESSION_CHANGE_KINDS`):
 *   - `answer`           — an answer the session OWNER gave (the
 *                          `listSessionAnswers` item, unchanged).
 *   - `proposal_decided` — a proposal filed under the session left `pending`:
 *                          approved, rejected, approval_failed, expired or
 *                          reverted. NOT `withdrawn` (the proposer's own act)
 *                          and NOT `auto_approved` (never pending).
 *                          `humanDecided` = the reviewer is a human user.
 *   - `stage_moved`      — the session's `currentStage` differs from the
 *                          caller's `knownStage`. STATE-derived, not cursored:
 *                          the pod keeps no stage ledger (the `stage_changed`
 *                          emit is a fan-out, not a row). Pass back
 *                          `state.currentStage` as `knownStage`. Stated limit:
 *                          a move and a move back between two reads (A→B→A)
 *                          is invisible.
 *   - `owner_message`    — a message the session OWNER typed in the session's
 *                          room: role `user` + author `human` + author = owner.
 *                          NOT the pod's recall notices (role `assistant`,
 *                          author `human`), NOT agent posts, NOT a teammate.
 *                          A reply that IS an answer is reported once, as
 *                          `answer`, when both kinds are asked for.
 *
 * CURSOR: `since` is EXCLUSIVE over each event's `at` (millisecond ISO — the
 * database's microseconds are truncated BEFORE the comparison, or a row would
 * be strictly newer than its own cursor forever). Events are ordered by `at`,
 * then `id`; `nextSince` = the last event's `at`. With no `since`, answers are
 * the UNREAD ones (`listSessionAnswers`' contract) and the other kinds count
 * from `floor` (the moment the wait began); an empty page then hands back
 * `floor` as `nextSince`, so a caller looping on it loses nothing between two
 * calls. `stage_moved` sits outside the cursor and the limit.
 *
 * PERSON-AUTHORED TEXT (an answer, an owner message, a rejection reason) is
 * DATA, never instructions: such an event carries `untrusted: true` and a
 * `fenced` copy (`fenceUntrustedData`) to inject into an agent's prompt.
 *
 * Owner-floored like the poll door: missing and not-yours are the same `null`.
 * A failed read THROWS — never an empty page.
 */

import {
  db,
  focusSessions,
  messages,
  proposals,
  users,
  MessageAuthorType,
  MessageRole,
  ProposalStatus,
  and,
  asc,
  eq,
  inArray,
  isNull,
  drizzleSql,
} from "@synap/database";
import type { SQLWrapper } from "drizzle-orm";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import {
  listSessionAnswers,
  SESSION_ANSWERS_DEFAULT_LIMIT,
  SESSION_ANSWERS_MAX_LIMIT,
  type SessionAnswerItem,
} from "./list-session-answers.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { extractProposalName } from "../proposals/fingerprint.js";
import { fenceUntrustedData } from "../agent-dispatch/binding-call.js";

export const SESSION_CHANGE_KINDS = [
  "answer",
  "proposal_decided",
  "stage_moved",
  "owner_message",
] as const;
export type SessionChangeKind = (typeof SESSION_CHANGE_KINDS)[number];

/**
 * The `events` argument both doors accept — an array (MCP) or a comma list
 * (Hub query) of kinds, `"all"` for every kind. ONE parser so the doors cannot
 * drift. `undefined` = the caller did not ask for the feed (answer-only wait).
 */
export function parseSessionChangeKinds(
  raw: unknown
):
  | { ok: true; kinds: Set<SessionChangeKind> | undefined }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, kinds: undefined };
  const items =
    typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw : null;
  if (!items) {
    return { ok: false, error: "events must be a list of event kinds." };
  }
  const tokens = items.map((v) => (typeof v === "string" ? v.trim() : v));
  if (tokens.length === 1 && tokens[0] === "all") {
    return { ok: true, kinds: new Set(SESSION_CHANGE_KINDS) };
  }
  const kinds = new Set<SessionChangeKind>();
  for (const t of tokens) {
    if (t === "") continue;
    if (!(SESSION_CHANGE_KINDS as readonly unknown[]).includes(t)) {
      return {
        ok: false,
        error: `Unknown event kind ${JSON.stringify(t)} — one of ${SESSION_CHANGE_KINDS.join(", ")}, or "all".`,
      };
    }
    kinds.add(t as SessionChangeKind);
  }
  if (kinds.size === 0) {
    return { ok: false, error: "events must name at least one event kind." };
  }
  return { ok: true, kinds };
}

/** The statuses a pending proposal is DECIDED into (see the header). */
export const DECIDED_PROPOSAL_STATUSES = [
  ProposalStatus.APPROVED,
  ProposalStatus.REJECTED,
  ProposalStatus.APPROVAL_FAILED,
  ProposalStatus.EXPIRED,
  ProposalStatus.REVERTED,
] as const;
export type ProposalDecision = (typeof DECIDED_PROPOSAL_STATUSES)[number];

interface EventBase {
  /** Stable id — dedupe on it across waits. */
  id: string;
  /** Millisecond ISO; the cursor axis (except `stage_moved`). */
  at: string;
}

export type SessionChangeEvent =
  | (EventBase & {
      kind: "answer";
      untrusted: true;
      /** The answer text, fenced as untrusted data for an agent prompt. */
      fenced: string;
      answer: SessionAnswerItem;
    })
  | (EventBase & {
      kind: "proposal_decided";
      /** True when `reason` carries a person's words. */
      untrusted: boolean;
      /** The rejection reason, fenced; null when there is none. */
      fenced: string | null;
      proposal: {
        id: string;
        title: string;
        proposalType: string;
        targetType: string;
        decision: ProposalDecision;
        /** The reviewer is a human user (not the pod, not an agent). */
        humanDecided: boolean;
        decidedBy: string | null;
        reason: string | null;
      };
    })
  | (EventBase & {
      kind: "stage_moved";
      from: string | null;
      to: string | null;
    })
  | (EventBase & {
      kind: "owner_message";
      untrusted: true;
      fenced: string;
      message: { id: string; text: string; authorId: string };
    });

export interface SessionChangesPage {
  sessionId: string;
  /** The cursor this page was read from (`null` = unread / from `floor`). */
  since: string | null;
  events: SessionChangeEvent[];
  /** Pass back as `since`. Never null once a floor or an event exists. */
  nextSince: string | null;
  hasMore: boolean;
  /** The session as it stands — pass `currentStage` back as `knownStage`. */
  state: { currentStage: string | null; status: string };
}

/** A timestamp column truncated to the millisecond, as a UTC ISO string. */
function msIso(col: SQLWrapper) {
  return drizzleSql<string>`to_char(date_trunc('milliseconds', ${col}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function byAtThenId(x: EventBase, y: EventBase): number {
  return x.at < y.at
    ? -1
    : x.at > y.at
      ? 1
      : x.id < y.id
        ? -1
        : x.id > y.id
          ? 1
          : 0;
}

export async function listSessionChanges(p: {
  sessionId: string;
  /** The owner floor (the operator for an agent key). */
  userId: string;
  kinds: ReadonlySet<SessionChangeKind>;
  since?: Date | null;
  /** With no `since`: the exclusive floor for proposals + owner messages. */
  floor?: Date | null;
  /** UNREAD answers (no `since`) — forwarded to `listSessionAnswers`. */
  skipPickedUp?: boolean;
  roomSince?: Date | null;
  /** The stage the caller last saw; `undefined` = no stage comparison. */
  knownStage?: string | null;
  limit?: number;
}): Promise<SessionChangesPage | null> {
  const limit = Math.max(
    1,
    Math.min(
      p.limit ?? SESSION_ANSWERS_DEFAULT_LIMIT,
      SESSION_ANSWERS_MAX_LIMIT
    )
  );
  const since = p.since ? p.since.toISOString() : null;
  const floor = since ?? (p.floor ? p.floor.toISOString() : null);

  const session = await db.query.focusSessions.findFirst({
    where: and(
      eq(focusSessions.id, p.sessionId),
      sessionReadableWhere({ userId: p.userId })
    ),
    columns: {
      id: true,
      userId: true,
      channelId: true,
      currentStage: true,
      status: true,
      updatedAt: true,
    },
  });
  if (!session) return null;
  const ownerId = session.userId;

  const cursored: SessionChangeEvent[] = [];
  let sourceHasMore = false;

  if (p.kinds.has("answer")) {
    const page = await listSessionAnswers({
      sessionId: session.id,
      userId: p.userId,
      since: p.since ?? null,
      limit,
      ...(p.skipPickedUp !== undefined ? { skipPickedUp: p.skipPickedUp } : {}),
      ...(p.roomSince !== undefined ? { roomSince: p.roomSince } : {}),
    });
    if (!page) return null;
    sourceHasMore ||= page.hasMore;
    for (const a of page.answers) {
      cursored.push({
        kind: "answer",
        id: a.id,
        at: a.answeredAt,
        untrusted: true,
        fenced: fenceUntrustedData(a.text, "synap session answer"),
        answer: a,
      });
    }
  }

  if (p.kinds.has("proposal_decided")) {
    const decidedAt = msIso(
      drizzleSql`coalesce(${proposals.reviewedAt}, ${proposals.updatedAt})`
    );
    const rows = await db
      .select({
        id: proposals.id,
        status: proposals.status,
        proposalType: proposals.proposalType,
        targetType: proposals.targetType,
        data: proposals.data,
        reviewedBy: proposals.reviewedBy,
        rejectionReason: proposals.rejectionReason,
        reviewerType: users.userType,
        at: decidedAt,
      })
      .from(proposals)
      .leftJoin(users, eq(users.id, proposals.reviewedBy))
      .where(
        and(
          eq(proposals.sessionId, session.id),
          inArray(proposals.status, [...DECIDED_PROPOSAL_STATUSES]),
          ...(floor ? [drizzleSql`${decidedAt} > ${floor}`] : [])
        )
      )
      .orderBy(asc(decidedAt), asc(proposals.id))
      .limit(limit + 1);
    sourceHasMore ||= rows.length > limit;
    for (const r of rows.slice(0, limit)) {
      const reason = r.rejectionReason?.trim() ? r.rejectionReason : null;
      cursored.push({
        kind: "proposal_decided",
        id: `proposal:${r.id}:${r.status}`,
        at: r.at,
        untrusted: reason !== null,
        fenced: reason
          ? fenceUntrustedData(reason, "synap proposal decision reason")
          : null,
        proposal: {
          id: r.id,
          title: buildObjectActionTitle({
            action: r.proposalType,
            objectKind: r.targetType,
            objectName: extractProposalName(r.data) ?? null,
            mood: "imperative",
          }),
          proposalType: r.proposalType,
          targetType: r.targetType,
          decision: r.status as ProposalDecision,
          humanDecided: r.reviewerType === "human",
          decidedBy: r.reviewedBy ?? null,
          reason,
        },
      });
    }
  }

  if (p.kinds.has("owner_message") && session.channelId) {
    const sentAt = msIso(messages.timestamp);
    const rows = await db
      .select({
        id: messages.id,
        content: messages.content,
        userId: messages.userId,
        at: sentAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.channelId, session.channelId),
          // The owner TYPING — the same predicate migration 0341 notifies on.
          eq(messages.role, MessageRole.USER),
          eq(messages.authorType, MessageAuthorType.HUMAN),
          eq(messages.userId, ownerId),
          isNull(messages.deletedAt),
          // The raw column bound first: it walks the (channel_id, timestamp)
          // index, where the truncated expression alone scanned the whole
          // room on every wake. It drops nothing the exact test keeps —
          // trunc(ts) > floor implies ts > floor.
          ...(floor
            ? [
                drizzleSql`${messages.timestamp} > ${floor}::timestamptz`,
                drizzleSql`${sentAt} > ${floor}`,
              ]
            : [])
        )
      )
      .orderBy(asc(sentAt), asc(messages.id))
      .limit(limit + 1);
    sourceHasMore ||= rows.length > limit;
    const answerIds = new Set(
      cursored.flatMap((e) =>
        e.kind === "answer" && e.answer.messageId ? [e.answer.messageId] : []
      )
    );
    for (const r of rows.slice(0, limit)) {
      if (answerIds.has(r.id)) continue; // reported once, as its answer
      cursored.push({
        kind: "owner_message",
        id: r.id,
        at: r.at,
        untrusted: true,
        fenced: fenceUntrustedData(r.content, "synap session owner message"),
        message: { id: r.id, text: r.content, authorId: r.userId },
      });
    }
  }

  cursored.sort(byAtThenId);
  const page = cursored.slice(0, limit);
  const events: SessionChangeEvent[] = [...page];

  const currentStage = session.currentStage ?? null;
  if (
    p.kinds.has("stage_moved") &&
    p.knownStage !== undefined &&
    p.knownStage !== currentStage
  ) {
    const at = session.updatedAt.toISOString();
    events.push({
      kind: "stage_moved",
      id: `stage:${session.id}:${currentStage ?? ""}:${at}`,
      at,
      from: p.knownStage,
      to: currentStage,
    });
  }

  const hasMore = sourceHasMore || cursored.length > limit;
  const lastAt = page.length ? page[page.length - 1]!.at : null;
  // Unread mode: an old unread answer must not pull the cursor back below the
  // floor (that would replay pre-wait history) — unless the page was cut, when
  // the cursor has to resume right after the last event handed out.
  const nextSince =
    lastAt === null
      ? floor
      : !since && floor && !hasMore && floor > lastAt
        ? floor
        : lastAt;

  return {
    sessionId: session.id,
    since,
    events,
    nextSince,
    hasMore,
    state: { currentStage, status: session.status },
  };
}
