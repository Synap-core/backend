/**
 * listConversationChanges — the session change feed for a whole agent
 * CONVERSATION: every event `listSessionChanges` reports, on every session
 * that conversation opened, in one page.
 *
 * Why: one Claude Code conversation works several pod sessions (it starts a
 * session per unit of work, its writes open receipts, its teammates share its
 * conversation id). A watcher that long-polls ONE session (synap-bridge's
 * binding) never hears about an approval, a merged PR or a message on the
 * others. Measured 2026-10-28: 41 of the newest 50 sessions were opened by 11
 * conversations, one of them holding 16 open sessions while its bridge watched
 * one; approvals on the 15 others woke nobody. The POD knows which sessions a
 * conversation opened (`metadata.clientKey`, stamped at create), so the pod
 * derives the set — no client keeps a list that could drift.
 *
 * THE SET (one definition, {@link conversationSessionsWhere}): the caller's
 * own sessions (owner floor) that this conversation STARTED — whose client key
 * names it (`…|conv:<harness>:<id>`, any key: the bridge and the agent may
 * hold different keys of one person), receipts included — UNION the sessions
 * it WORKS NOW: those it holds a LIVE runner row on (`session_runners`, any
 * key and process; live = seen within `RUNNER_LIVE_WINDOW_SECONDS` and not
 * `ended`). A teammate lane's session is started under its lead's
 * conversation key or none, so without the second half a person's room post
 * to that lane reached no conversation (sessions cockpit C3, M5). Open, or
 * closed in the last {@link CONVERSATION_CLOSED_GRACE_HOURS} h (a proposal is
 * often decided after its session closed). Newest first, at most
 * {@link CONVERSATION_SESSIONS_MAX}.
 *
 * Only a conversation the client NAMED counts (`X-Synap-Conversation`,
 * `parseRunnerClientKey`): a pod-minted MCP session id or a key-scoped client
 * has no conversation a person could reopen, so it gets `null` (the door says
 * so) — never an empty page.
 *
 * Kinds: every kind but `stage_moved`, which is per-session state (a
 * `knownStage` per session); asked for, it is listed in `notCovered`.
 * Each event carries `session` ({id, title}) — which piece of work it is about.
 * Same exclusive `since` cursor and same floor semantics as one session.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  focusSessions,
  sessionRunners,
  and,
  desc,
  eq,
  gt,
  inArray,
  or,
  drizzleSql,
} from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  listSessionChanges,
  type SessionChangeEvent,
  type SessionChangeKind,
} from "./session-changes.js";
import {
  parseRunnerClientKey,
  RUNNER_LIVE_WINDOW_SECONDS,
} from "./session-runners.js";
import { OPEN_SESSION_STATUSES } from "./session-statuses.js";
import {
  SESSION_ANSWERS_DEFAULT_LIMIT,
  SESSION_ANSWERS_MAX_LIMIT,
} from "./list-session-answers.js";

const logger = createLogger({ module: "conversation-changes" });

/** Sessions of one conversation read per page (newest first). */
export const CONVERSATION_SESSIONS_MAX = 25;
/** A session closed this recently is still watched (late decisions). */
export const CONVERSATION_CLOSED_GRACE_HOURS = 24;

export type ConversationChangeEvent = SessionChangeEvent & {
  session: { id: string; title: string };
};

export interface ConversationChangesPage {
  scope: "conversation";
  /** `<harness>:<id>` — the conversation the request named. */
  conversation: string;
  /** The sessions read, newest first. */
  sessions: Array<{ id: string; title: string; status: string }>;
  since: string | null;
  events: ConversationChangeEvent[];
  nextSince: string | null;
  hasMore: boolean;
  /** Kinds asked for that this scope does not report (`stage_moved`). */
  notCovered: SessionChangeKind[];
}

/** `<harness>:<id>` of a client key, or null when it names no conversation. */
export function namedConversationOf(
  clientKey: string | null | undefined
): string | null {
  const parsed = parseRunnerClientKey(clientKey);
  return parsed ? `${parsed.harness}:${parsed.conversationId}` : null;
}

/**
 * THE set of sessions a conversation belongs to, as one WHERE on
 * `focus_sessions`: those it STARTED (`metadata.clientKey` names it) ∪ those
 * it holds a LIVE runner on. `conversation` is `<harness>:<id>`. The owner
 * floor is the caller's; this adds no floor of its own.
 */
export function conversationSessionsWhere(conversation: string, now?: Date) {
  const suffix = `|conv:${conversation}`;
  const colon = conversation.indexOf(":");
  const harness = conversation.slice(0, colon);
  const conversationId = conversation.slice(colon + 1);
  const liveSince = new Date(
    (now ?? new Date()).getTime() - RUNNER_LIVE_WINDOW_SECONDS * 1000
  );
  return or(
    // `right(…) = suffix`, not LIKE: a conversation id may hold `%` or `_`.
    drizzleSql`right(${focusSessions.metadata} ->> 'clientKey', ${suffix.length}) = ${suffix}`,
    // A live runner of this conversation (the runner primary key leads with
    // the session id, so this is one index probe per candidate).
    colon > 0
      ? drizzleSql`EXISTS (SELECT 1 FROM ${sessionRunners} WHERE ${sessionRunners.sessionId} = ${focusSessions.id} AND ${sessionRunners.harness} = ${harness} AND ${sessionRunners.conversationId} = ${conversationId} AND ${sessionRunners.lastSeenAt} > ${liveSince.toISOString()}::timestamptz AND ${sessionRunners.state} IS DISTINCT FROM 'ended')`
      : drizzleSql`false`
  );
}

/** The sessions a conversation started or works now that are worth watching. */
export async function listConversationSessions(p: {
  userId: string;
  conversation: string;
  now?: Date;
}): Promise<Array<{ id: string; title: string; status: string }>> {
  const graceStart = new Date(
    (p.now ?? new Date()).getTime() -
      CONVERSATION_CLOSED_GRACE_HOURS * 3_600_000
  );
  const rows = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      status: focusSessions.status,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, p.userId),
        conversationSessionsWhere(p.conversation, p.now),
        or(
          inArray(focusSessions.status, [...OPEN_SESSION_STATUSES]),
          gt(focusSessions.updatedAt, graceStart)
        )
      )
    )
    // SESSION-KIND-LENS-EXEMPT: one conversation's own sessions, every kind (its receipts carry its proposals); ids + titles for a watcher, never a page.
    .orderBy(desc(focusSessions.updatedAt))
    .limit(CONVERSATION_SESSIONS_MAX);
  return rows.map((r) => ({
    id: r.id,
    title: resolveSessionTitle(r),
    status: r.status,
  }));
}

export async function listConversationChanges(p: {
  userId: string;
  /** `<harness>:<id>` (see {@link namedConversationOf}). */
  conversation: string;
  kinds: ReadonlySet<SessionChangeKind>;
  since?: Date | null;
  floor?: Date | null;
  skipPickedUp?: boolean;
  roomSince?: Date | null;
  limit?: number;
  /** The reading key's agent user (null: a person): the `wake` verdict's viewer. */
  viewerAgentUserId?: string | null;
  /** Called with the set once it is known, before its changes are read. */
  onSessions?: (ids: readonly string[]) => void;
}): Promise<ConversationChangesPage> {
  const notCovered: SessionChangeKind[] = p.kinds.has("stage_moved")
    ? ["stage_moved"]
    : [];
  const kinds = new Set([...p.kinds].filter((k) => k !== "stage_moved"));
  const sessions = await listConversationSessions({
    userId: p.userId,
    conversation: p.conversation,
  });
  p.onSessions?.(sessions.map((s) => s.id));
  const since = p.since ? p.since.toISOString() : null;
  const floor = since ?? (p.floor ? p.floor.toISOString() : null);
  const empty = (): ConversationChangesPage => ({
    scope: "conversation",
    conversation: p.conversation,
    sessions,
    since,
    events: [],
    nextSince: floor,
    hasMore: false,
    notCovered,
  });
  if (sessions.length === 0 || kinds.size === 0) return empty();

  // One read per session, each cursored on the same `since`: `at` is one axis
  // (millisecond ISO) for every session, so the merged page keeps the same
  // exclusive-cursor contract — every unreturned event is newer than the
  // merged page's last `at`, because each session's page is its oldest.
  const pages = await Promise.all(
    sessions.map((s) =>
      listSessionChanges({
        sessionId: s.id,
        userId: p.userId,
        kinds,
        since: p.since ?? null,
        floor: p.floor ?? null,
        ...(p.skipPickedUp !== undefined
          ? { skipPickedUp: p.skipPickedUp }
          : {}),
        ...(p.roomSince !== undefined ? { roomSince: p.roomSince } : {}),
        limit: p.limit,
        viewerAgentUserId: p.viewerAgentUserId ?? null,
      }).then((page) => ({ s, page }))
    )
  );
  const limit = Math.max(
    1,
    Math.min(
      p.limit ?? SESSION_ANSWERS_DEFAULT_LIMIT,
      SESSION_ANSWERS_MAX_LIMIT
    )
  );
  let sourceHasMore = false;
  const merged: ConversationChangeEvent[] = [];
  for (const { s, page } of pages) {
    // Listed a moment ago and owner-floored: a null here is a session that
    // went away between the two reads, not a failure.
    if (!page) {
      logger.debug({ sessionId: s.id }, "conversation session vanished");
      continue;
    }
    sourceHasMore ||= page.hasMore;
    for (const e of page.events) {
      merged.push({ ...e, session: { id: s.id, title: s.title } });
    }
  }
  merged.sort((x, y) =>
    x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  );
  const events = merged.slice(0, limit);
  const hasMore = sourceHasMore || merged.length > limit;
  const lastAt = events.length ? events[events.length - 1]!.at : null;
  const nextSince =
    lastAt === null
      ? floor
      : !since && floor && !hasMore && floor > lastAt
        ? floor
        : lastAt;
  return {
    scope: "conversation",
    conversation: p.conversation,
    sessions,
    since,
    events,
    nextSince,
    hasMore,
    notCovered,
  };
}
