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
 *   - `session_message`  — a COORDINATION POST another session's agent
 *                          addressed to this session (`sessionPost`, the
 *                          inbox predicate in `session-inbox.ts`): `intent`,
 *                          `from` (its session, agent, harness), the text
 *                          fenced, and `wake` — stamped at the post (only
 *                          blocked_on_you / handoff, inside the loop and rate
 *                          guards) and false once the session's agent read
 *                          it. `id` = the message id: pass it back as `cause`
 *                          when replying. With no `since`: the UNREAD ones
 *                          (no read receipt yet), any age — like answers.
 *   - `pr_merged` /      — a pull request of the session was merged / closed
 *     `pr_closed`          without merging: the `dev.pr_merged` / `dev.pr_closed`
 *                          fact the pod recorded (GitHub webhook, CI or devbox
 *                          producer). "Of the session" = the fact was resolved
 *                          to it (`data.sessionId`, its `Pod session:` line or
 *                          its outcome), or it is a PR the session declared as
 *                          an outcome `ref`. `at` = when the POD heard of it
 *                          (`data.ingestedAt`, else the row time), so a late
 *                          webhook is not dropped behind the cursor. The PR
 *                          title is the author's words: `fenced`, untrusted.
 *   - `checks_finished`  — a CI run or a devbox gate job of the session ended
 *                          with a verdict (`ci.finished`, status success /
 *                          failure / timed_out; a cancelled or skipped run
 *                          settles nothing and is not reported). "Of the
 *                          session" = the fact names it (`data.sessionId`: a
 *                          PR body's `Pod session:` line, a devbox job's
 *                          `GATE_POD_SESSION`) or it ran for a PR the session
 *                          declared as an outcome (`data.pr`). ONE per (PR,
 *                          head sha), or per (devbox job, sha) — a re-run on
 *                          the same sha does not wake again. `at` = when the
 *                          pod heard of it, as for a PR.
 *   - `status_moved`     — the session's status moved (the transition log,
 *                          `lifecycle_transition_outbox`: every move through
 *                          the session doors, the reaper's and a hold's resume
 *                          included). `at` = when the move was RECORDED;
 *                          `move.occurredAt` = when it happened (a backdated
 *                          move says so).
 *   - `hold_set`         — a move that carries a hold (a pause, or a move
 *                          between two pauses): `move.hold` says what it waits
 *                          on and how it resumes. When both kinds are asked
 *                          for, such a move is reported once, as `hold_set`.
 *   - `blocker_ended`    — a session this one waits on (`blocked_by`) ended:
 *                          `delivered` = it closed, false = it was cancelled
 *                          or failed (re-plan: the edge does not clear by
 *                          itself). `at` = when its end was recorded.
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
 * WAKE: a status move writes the session row, whose NOTIFY (0277) wakes a held
 * wait at once; a CI fact or a blocker's end does not touch this session's
 * row, so a held wait sees it on its fallback poll (5 s, 15 s for a
 * conversation), as it sees a PR's merge.
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
  events as eventsTable,
  focusSessions,
  lifecycleTransitionOutbox,
  links,
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
  or,
  drizzleSql,
} from "@synap/database";
import type { SQLWrapper } from "drizzle-orm";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import {
  DEV_LOOP_EVENT_TYPES,
  ciVerdictOf,
  devboxJobOf,
  parsePullRequestRef,
  pullRequestUrl,
  type CiFinishedStatus,
  type PullRequestChecks,
  type PullRequestRef,
} from "@synap-core/types";
import { DEPENDENCY_LINK_TYPE } from "@synap-core/types/connections";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import type {
  LifecycleCategory,
  RecordedHold,
  TransitionBase,
} from "@synap-core/types/lifecycle";
import {
  listSessionAnswers,
  SESSION_ANSWERS_DEFAULT_LIMIT,
  SESSION_ANSWERS_MAX_LIMIT,
  type SessionAnswerItem,
} from "./list-session-answers.js";
import { sessionReadableWhere } from "../../access/session-visibility.js";
import { eventVisibleWhere } from "../../access/event-visibility.js";
import { extractProposalName } from "../proposals/fingerprint.js";
import { fenceUntrustedData } from "../agent-dispatch/binding-call.js";
import type {
  SessionPostIntent,
  SessionPostMeta,
  SessionPostRef,
} from "@synap-core/types/agents";
import {
  addressedPost,
  addressedToSessionWhere,
  unreadSessionPostWhere,
} from "./session-inbox.js";

export const SESSION_CHANGE_KINDS = [
  "answer",
  "proposal_decided",
  "stage_moved",
  "owner_message",
  "session_message",
  "pr_merged",
  "pr_closed",
  "checks_finished",
  "status_moved",
  "hold_set",
  "blocker_ended",
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
    })
  | (EventBase & {
      kind: "session_message";
      /** Another agent's words: data, never instructions. */
      untrusted: true;
      fenced: string;
      /** Ring the doorbell for this one? Decided at the post; false once read. */
      wake: boolean;
      intent: SessionPostIntent;
      from: SessionPostMeta["from"];
      message: {
        id: string;
        text: string;
        refs?: SessionPostRef[];
        /** The post this one replies to (its wake chain). */
        cause?: string;
        hop: number;
        /** Why a wake-worthy post was delivered without waking. */
        wakeHeld?: SessionPostMeta["wakeHeld"];
        readAt: string | null;
      };
    })
  | (EventBase & {
      kind: "pr_merged" | "pr_closed";
      /** The PR title is its author's words: data, never instructions. */
      untrusted: true;
      /** The title, fenced; null when the fact carried none. */
      fenced: string | null;
      pr: {
        repo: string;
        number: number;
        url: string;
        title: string | null;
        /** Merged into the default branch (only then is it delivered). */
        intoDefault: boolean | null;
        base: string | null;
      };
    })
  | (EventBase & {
      kind: "checks_finished";
      checks: {
        repo: string;
        sha: string;
        /** What the run says: `passed` (success) or `failed` (failure, timed out). */
        result: PullRequestChecks;
        status: CiFinishedStatus;
        /** The PR the run was for; null for a devbox job tied to none. */
        pr: { number: number; url: string } | null;
        /** The devbox job (a `devbox <name>` run); null for a CI workflow. */
        job: string | null;
        workflow: string | null;
        /** The run's page, when the producer gave one. */
        url: string | null;
      };
    })
  | (EventBase & {
      kind: "status_moved" | "hold_set";
      /** True when the mover's reason (or the hold's) is in `fenced`. */
      untrusted: boolean;
      /** The hold's reason, else the move's, fenced; null when there is none. */
      fenced: string | null;
      move: {
        from: string | null;
        to: string;
        category: LifecycleCategory;
        actor: TransitionBase["actorKind"];
        reason: string | null;
        /** When it happened; `at` is when it was recorded. */
        occurredAt: string;
        backdated: boolean;
        /** What the pause waits on and how it resumes; null on `status_moved`. */
        hold: RecordedHold | null;
      };
    })
  | (EventBase & {
      kind: "blocker_ended";
      blocker: {
        sessionId: string;
        /** Null when the reader may not see that session. */
        title: string | null;
        status: string;
        /** It closed (done). False: cancelled or failed — re-plan the wait. */
        delivered: boolean;
      };
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

/**
 * The pull requests a session DECLARED: every outcome whose `ref.url` is a PR
 * (the work-units rule records each PR as `pr-<repo>-<n>` with its url).
 */
export function sessionPullRequestRefs(
  expectedOutputs: unknown
): PullRequestRef[] {
  if (!Array.isArray(expectedOutputs)) return [];
  const out = new Map<string, PullRequestRef>();
  for (const o of expectedOutputs) {
    const url = (o as { ref?: { url?: unknown } } | null)?.ref?.url;
    const ref = typeof url === "string" ? parsePullRequestRef(url) : null;
    if (ref) out.set(`${ref.repo.toLowerCase()}#${ref.number}`, ref);
  }
  return [...out.values()];
}

/**
 * The dev facts (`dev.pr_*`, `ci.finished`) OF a session: the fact names it
 * (`data.sessionId`: a PR body's `Pod session:` line, a devbox job's pod
 * session, or the resolver's stamp), or — only when the fact names NO session —
 * it is about a PR the session declared as an outcome (a PR fact by its
 * `number`, a CI run by its `pr`). A fact stamped for session A never wakes B
 * through a shared PR, and appears once in a feed. ONE rule for the change
 * feed and the session timeline.
 */
export function sessionDevFactWhere(
  sessionId: string,
  refs: readonly PullRequestRef[]
) {
  const ci = DEV_LOOP_EVENT_TYPES.ciFinished;
  return or(
    drizzleSql`${eventsTable.data}->>'sessionId' = ${sessionId}`,
    ...refs.map(
      (r) =>
        drizzleSql`(${eventsTable.data}->>'sessionId' is null and lower(${eventsTable.data}->>'repo') = ${r.repo.toLowerCase()} and ${eventsTable.data}->>(case when ${eventsTable.type} = ${ci} then 'pr' else 'number' end) = ${String(r.number)})`
    )
  )!;
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

const SETTLED_RUN_STATUSES: readonly CiFinishedStatus[] = [
  "success",
  "failure",
  "timed_out",
];

/**
 * Keep a `ci.finished` row only when it settled something AND is the FIRST
 * settled run of its key — (repo, sha, PR) for a PR's run, (repo, sha,
 * workflow) for a devbox job or a run tied to no PR — so a re-run on the same
 * sha wakes nobody again. Other types pass. The subject id (`repo@sha`, both
 * producers) walks the subject index.
 */
function firstSettledRunWhere(ci: string) {
  const e = eventsTable;
  const key = (data: SQLWrapper) =>
    drizzleSql`coalesce('pr:' || (${data}->>'pr'), 'wf:' || (${data}->>'workflow'), '')`;
  const heard = (t: string) =>
    drizzleSql.raw(
      `coalesce((${t}.data->>'ingestedAt')::timestamptz, ${t}.timestamp)`
    );
  const settled = SETTLED_RUN_STATUSES.map((st) => drizzleSql`${st}`);
  return drizzleSql`(${e.type} <> ${ci} or (
    ${e.data}->>'status' in (${drizzleSql.join(settled, drizzleSql`, `)})
    and not exists (
      select 1 from events prior
       where prior.type = ${ci}
         and prior.subject_id = ${e.subjectId}
         and lower(prior.data->>'repo') = lower(${e.data}->>'repo')
         and lower(prior.data->>'sha') = lower(${e.data}->>'sha')
         and prior.data->>'status' in (${drizzleSql.join(settled, drizzleSql`, `)})
         and ${key(drizzleSql.raw("prior.data"))} = ${key(e.data)}
         and (${heard("prior")}, prior.id) < (${heard("events")}, ${e.id})
    )))`;
}

/** A `ci.finished` payload as the feed carries it; null when it settles nothing. */
function checksOf(
  d: Record<string, unknown>
): Extract<SessionChangeEvent, { kind: "checks_finished" }>["checks"] | null {
  const status = d.status as CiFinishedStatus;
  const result = ciVerdictOf(status);
  const repo = typeof d.repo === "string" ? d.repo : null;
  const sha = typeof d.sha === "string" ? d.sha : null;
  if (!result || !repo || !sha) return null;
  const workflow = typeof d.workflow === "string" ? d.workflow : null;
  const number = typeof d.pr === "number" ? d.pr : null;
  return {
    repo,
    sha,
    result,
    status,
    pr:
      number === null
        ? null
        : { number, url: pullRequestUrl({ repo, number }) },
    job: devboxJobOf(workflow),
    workflow,
    url: typeof d.url === "string" ? d.url : null,
  };
}

/** A transition row as recorded (`StatusTransition`); null when it is not one. */
function readTransition(raw: unknown): TransitionBase | null {
  const t = (
    typeof raw === "string" ? JSON.parse(raw) : raw
  ) as TransitionBase | null;
  return t && typeof t.to === "string" && typeof t.subjectId === "string"
    ? t
    : null;
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
      expectedOutputs: true,
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

  if (p.kinds.has("session_message") && session.channelId) {
    const sentAt = msIso(messages.timestamp);
    const rows = await db
      .select({
        id: messages.id,
        content: messages.content,
        metadata: messages.metadata,
        timestamp: messages.timestamp,
        at: sentAt,
      })
      .from(messages)
      .where(
        and(
          addressedToSessionWhere({
            channelId: session.channelId,
            sessionId: session.id,
          }),
          ...(since
            ? [
                drizzleSql`${messages.timestamp} > ${since}::timestamptz`,
                drizzleSql`${sentAt} > ${since}`,
              ]
            : p.skipPickedUp
              ? // UNREAD, any age — the answers' contract: mail that landed
                // while the agent was away still counts.
                [unreadSessionPostWhere()]
              : floor
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
    for (const r of rows.slice(0, limit)) {
      const posted = addressedPost(r);
      if (!posted) continue;
      const { meta } = posted;
      cursored.push({
        kind: "session_message",
        id: r.id,
        at: r.at,
        untrusted: true,
        fenced: fenceUntrustedData(
          r.content,
          `synap message from another session (${meta.intent})`
        ),
        wake: meta.wake && !meta.readAt,
        intent: meta.intent,
        from: meta.from,
        message: {
          id: r.id,
          text: r.content,
          ...(meta.refs ? { refs: meta.refs } : {}),
          ...(meta.cause ? { cause: meta.cause } : {}),
          hop: meta.hop,
          ...(meta.wakeHeld ? { wakeHeld: meta.wakeHeld } : {}),
          readAt: meta.readAt ?? null,
        },
      });
    }
  }

  const prKinds = (["pr_merged", "pr_closed"] as const).filter((k) =>
    p.kinds.has(k)
  );
  const checksKind = p.kinds.has("checks_finished");
  if (prKinds.length > 0 || checksKind) {
    const types = prKinds.map((k) =>
      k === "pr_merged"
        ? DEV_LOOP_EVENT_TYPES.prMerged
        : DEV_LOOP_EVENT_TYPES.prClosed
    );
    const ci = DEV_LOOP_EVENT_TYPES.ciFinished;
    // When the pod HEARD of it, not when it happened: a webhook that lands
    // after the caller's cursor moved past `merged_at` is still news.
    const heardAt = msIso(
      drizzleSql`coalesce((${eventsTable.data}->>'ingestedAt')::timestamptz, ${eventsTable.timestamp})`
    );
    const rows = await db
      .select({
        id: eventsTable.id,
        type: eventsTable.type,
        data: eventsTable.data,
        at: heardAt,
      })
      .from(eventsTable)
      .where(
        and(
          inArray(eventsTable.type, checksKind ? [...types, ci] : types),
          sessionDevFactWhere(
            session.id,
            sessionPullRequestRefs(session.expectedOutputs)
          ),
          eventVisibleWhere({ userId: p.userId, roster: false }),
          ...(checksKind ? [firstSettledRunWhere(ci)] : []),
          ...(floor
            ? [
                // The raw column first: it walks the timestamp index (and the
                // hypertable's chunks). Stated limit: a fact that HAPPENED more
                // than a day before the pod heard of it is not reported.
                drizzleSql`${eventsTable.timestamp} > ${floor}::timestamptz - interval '1 day'`,
                drizzleSql`${heardAt} > ${floor}`,
              ]
            : [])
        )
      )
      .orderBy(asc(heardAt), asc(eventsTable.id))
      .limit(limit + 1);
    sourceHasMore ||= rows.length > limit;
    for (const r of rows.slice(0, limit)) {
      const d = (r.data ?? {}) as Record<string, unknown>;
      if (r.type === ci) {
        const checks = checksOf(d);
        if (checks) {
          cursored.push({
            kind: "checks_finished",
            id: `event:${r.id}`,
            at: r.at,
            checks,
          });
        }
        continue;
      }
      const repo = typeof d.repo === "string" ? d.repo : null;
      const number = typeof d.number === "number" ? d.number : null;
      const url = typeof d.url === "string" ? d.url : null;
      if (!repo || number === null || !url) continue;
      const title =
        typeof d.title === "string" && d.title.trim() ? d.title : null;
      cursored.push({
        kind:
          r.type === DEV_LOOP_EVENT_TYPES.prMerged ? "pr_merged" : "pr_closed",
        id: `event:${r.id}`,
        at: r.at,
        untrusted: true,
        fenced: title
          ? fenceUntrustedData(title, "github pull request title")
          : null,
        pr: {
          repo,
          number,
          url,
          title,
          intoDefault:
            typeof d.intoDefault === "boolean" ? d.intoDefault : null,
          base: typeof d.base === "string" ? d.base : null,
        },
      });
    }
  }

  const moveKinds = p.kinds.has("status_moved") || p.kinds.has("hold_set");
  if (moveKinds) {
    const recordedAt = msIso(
      drizzleSql`coalesce((${lifecycleTransitionOutbox.transition}->>'recordedAt')::timestamptz, ${lifecycleTransitionOutbox.createdAt})`
    );
    const rows = await db
      .select({
        id: lifecycleTransitionOutbox.transitionId,
        transition: lifecycleTransitionOutbox.transition,
        at: recordedAt,
      })
      .from(lifecycleTransitionOutbox)
      .where(
        and(
          // The subject index (0374): coalesce(subjectId, entityId), created_at.
          drizzleSql`coalesce(${lifecycleTransitionOutbox.transition}->>'subjectId', ${lifecycleTransitionOutbox.transition}->>'entityId') = ${session.id}`,
          drizzleSql`${lifecycleTransitionOutbox.transition}->>'subjectType' = 'focus_session'`,
          ...(p.kinds.has("status_moved")
            ? []
            : [
                drizzleSql`jsonb_typeof(${lifecycleTransitionOutbox.transition}->'hold') = 'object'`,
              ]),
          ...(floor
            ? [
                drizzleSql`${lifecycleTransitionOutbox.createdAt} > ${floor}::timestamptz - interval '1 minute'`,
                drizzleSql`${recordedAt} > ${floor}`,
              ]
            : [])
        )
      )
      .orderBy(asc(recordedAt), asc(lifecycleTransitionOutbox.transitionId))
      .limit(limit + 1);
    sourceHasMore ||= rows.length > limit;
    for (const r of rows.slice(0, limit)) {
      const t = readTransition(r.transition);
      if (!t) continue;
      const held = t.hold && p.kinds.has("hold_set") ? t.hold : null;
      const reason = t.hold?.reason?.trim() || t.reason?.trim() || null;
      cursored.push({
        kind: held ? "hold_set" : "status_moved",
        id: `transition:${r.id}`,
        at: r.at,
        untrusted: reason !== null,
        fenced: reason
          ? fenceUntrustedData(reason, "synap status move reason")
          : null,
        move: {
          from: t.from,
          to: t.to,
          category: t.category,
          actor: t.actorKind,
          reason: t.reason ?? null,
          occurredAt: t.occurredAt,
          backdated: t.backdated === true,
          hold: held,
        },
      });
    }
  }

  if (p.kinds.has("blocker_ended")) {
    // The sessions this one waits on (its `blocked_by` edges), then their
    // ends through the subject index — never a scan of the whole log.
    const blockerIds = (
      await db
        .select({ id: links.toId })
        .from(links)
        .where(
          and(
            eq(links.fromType, "session" as never),
            eq(links.fromId, session.id),
            eq(links.linkType, DEPENDENCY_LINK_TYPE),
            eq(links.toType, "session" as never)
          )
        )
    ).map((r) => r.id);
    if (blockerIds.length > 0) {
      const recordedAt = msIso(
        drizzleSql`coalesce((${lifecycleTransitionOutbox.transition}->>'recordedAt')::timestamptz, ${lifecycleTransitionOutbox.createdAt})`
      );
      const [rows, named] = await Promise.all([
        db
          .select({
            id: lifecycleTransitionOutbox.transitionId,
            transition: lifecycleTransitionOutbox.transition,
            at: recordedAt,
          })
          .from(lifecycleTransitionOutbox)
          .where(
            and(
              inArray(
                drizzleSql`coalesce(${lifecycleTransitionOutbox.transition}->>'subjectId', ${lifecycleTransitionOutbox.transition}->>'entityId')`,
                blockerIds
              ),
              drizzleSql`${lifecycleTransitionOutbox.transition}->>'subjectType' = 'focus_session'`,
              inArray(
                drizzleSql`${lifecycleTransitionOutbox.transition}->>'category'`,
                ["done", "lost"]
              ),
              ...(floor
                ? [
                    drizzleSql`${lifecycleTransitionOutbox.createdAt} > ${floor}::timestamptz - interval '1 minute'`,
                    drizzleSql`${recordedAt} > ${floor}`,
                  ]
                : [])
            )
          )
          .orderBy(asc(recordedAt), asc(lifecycleTransitionOutbox.transitionId))
          .limit(limit + 1),
        db
          .select({
            id: focusSessions.id,
            title: focusSessions.title,
            goal: focusSessions.goal,
          })
          .from(focusSessions)
          .where(
            and(
              inArray(focusSessions.id, blockerIds),
              sessionReadableWhere({ userId: p.userId })
            )
          ),
      ]);
      const titleOf = new Map(
        named.map((r) => [r.id, resolveSessionTitle(r) || null])
      );
      sourceHasMore ||= rows.length > limit;
      for (const r of rows.slice(0, limit)) {
        const t = readTransition(r.transition);
        if (!t) continue;
        cursored.push({
          kind: "blocker_ended",
          // Not `transition:<id>`: in a conversation's feed the blocker's own
          // `status_moved` carries that id, and one id must name one event.
          id: `blocker:${r.id}`,
          at: r.at,
          blocker: {
            sessionId: t.subjectId,
            title: titleOf.get(t.subjectId) ?? null,
            status: t.to,
            delivered: t.category === "done",
          },
        });
      }
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
