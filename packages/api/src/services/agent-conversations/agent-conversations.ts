/**
 * Agent conversations (0354) — THE ONE REGISTRY of live agent terminals.
 *
 * WRITE: {@link recordHeartbeat}, the Hub heartbeat door's only effect. An
 * idempotent upsert keyed by (person, computer, harness, conversation):
 *   - TELEMETRY, like `api_keys.last_used_at` and `session_runners` — no
 *     governance proposal: it records that a terminal is open and changes
 *     nothing a person owns;
 *   - THROTTLED in SQL (the upsert's `WHERE`): an unchanged heartbeat rewrites
 *     the row at most every {@link HEARTBEAT_REWRITE_SECONDS}, so a hook firing
 *     on every tool call costs one write per interval; a changed state,
 *     sub-agent count, folder or end is written at once;
 *   - `stateSince` is the server's clock: it moves only when `state` changes
 *     (or the conversation is resumed after it ended);
 *   - `ended: true` closes the row (`ended_at`); any later heartbeat for the
 *     same conversation reopens it (Claude Code `--resume` keeps the id).
 * Only {@link decodeHeartbeat}'s output reaches the store: see its file for
 * what is never stored.
 *
 * SESSION LINK: `session_runners` (0342), never a column here. A heartbeat
 * naming `sessionId` stamps a runner row through the ONE runner door
 * (`stampSessionRunner`, explicit identity, no path); readers join runners on
 * (harness, conversation_id). The bound session is the most recently stamped
 * runner of the conversation.
 *
 * READ: {@link loadLiveTerminals} (`synap_list_agents`, per computer) and
 * {@link loadSessionRunnerTerminals} (`focusSessions.list`, per session). Both
 * floor on the owner (`user_id` — the access rule in `access/registry.ts`).
 * PRUNE: the hourly focus-session reaper (`@synap/jobs`,
 * `pruneAgentConversations`) deletes ended or abandoned rows after a week.
 * A failed read THROWS: "no terminal is open" and "could not tell" are
 * different answers.
 */

import {
  db,
  agentConversations,
  focusSessions,
  sessionRunners,
  and,
  eq,
  desc,
  inArray,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  machineOfAgentSql,
  RUNNER_LIVE_WINDOW_SECONDS,
  runnerClientKey,
  stampSessionRunner,
} from "../focus-sessions/session-runners.js";
import type { DecodedHeartbeat } from "./heartbeat-codec.js";

/** The most often an UNCHANGED heartbeat rewrites its row. */
export const HEARTBEAT_REWRITE_SECONDS = 30;

/**
 * How long after its last heartbeat an open conversation still reads as live.
 * The contract asks reporters to beat at least every 5 minutes while the
 * conversation is open (and on every state change): three missed beats.
 */
export const CONVERSATION_LIVE_WINDOW_SECONDS = 15 * 60;

/** The conversation as the heartbeat door answers it. */
export interface HeartbeatAnswer {
  conversation: {
    id: string;
    computer: string;
    harness: string;
    conversationId: string;
    state: DecodedHeartbeat["state"];
    stateSince: string;
    endedAt: string | null;
  };
  /** false = throttled (nothing changed within the rewrite interval). */
  written: boolean;
  /**
   * The session the heartbeat named, once its runner row exists; null when
   * none was named, the conversation ended, or the caller has no key to name
   * a runner with (`reason`).
   */
  sessionId: string | null;
  sessionLinkSkipped?: "no_api_key" | "ended";
}

export type HeartbeatResult =
  | { ok: true; answer: HeartbeatAnswer }
  | { ok: false; status: 404; error: string };

/**
 * Record one heartbeat. `userId` is the person the key acts for (the floor);
 * `agentUserId` / `apiKeyId` come from the key, never from the body.
 */
export async function recordHeartbeat(p: {
  userId: string;
  agentUserId: string | null;
  apiKeyId: string | null;
  heartbeat: DecodedHeartbeat;
  database?: typeof db;
}): Promise<HeartbeatResult> {
  const database = p.database ?? db;
  const hb = p.heartbeat;

  // A conversation may only bind a session its person owns: never stamp a
  // runner onto someone else's session (a stranger's id reads as none).
  if (hb.sessionId) {
    const [owned] = await database
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, hb.sessionId),
          drizzleSql`${p.userId} IS NOT NULL`
        )
      )
      .limit(1);
    if (!owned) {
      return {
        ok: false,
        status: 404,
        error: `Focus session ${hb.sessionId} not found`,
      };
    }
  }

  const t = agentConversations;
  const written = await database
    .insert(t)
    .values({
      userId: p.userId,
      agentUserId: p.agentUserId,
      apiKeyId: p.apiKeyId,
      machineUserId: machineOfAgentSql(p.agentUserId),
      computer: hb.computer,
      harness: hb.harness,
      conversationId: hb.conversationId,
      folder: hb.folder,
      state: hb.state,
      subagentCount: hb.subagentCount,
      endedAt: null,
    })
    .onConflictDoUpdate({
      target: [t.userId, t.computer, t.harness, t.conversationId],
      set: {
        lastSeenAt: drizzleSql`now()`,
        // The server's clock: `since` moves only on a real change of state,
        // or when an ended conversation comes back.
        stateSince: drizzleSql`CASE WHEN false AND ${t.state} = excluded.state AND ${t.endedAt} IS NULL THEN ${t.stateSince} ELSE now() END`,
        state: drizzleSql`excluded.state`,
        folder: drizzleSql`coalesce(excluded.folder, ${t.folder})`,
        subagentCount: drizzleSql`excluded.subagent_count`,
        agentUserId: drizzleSql`excluded.agent_user_id`,
        apiKeyId: drizzleSql`excluded.api_key_id`,
        machineUserId: drizzleSql`coalesce(excluded.machine_user_id, ${t.machineUserId})`,
        // ended → stamped; any other beat → reopened.
        endedAt: drizzleSql`CASE WHEN excluded.ended_at IS NULL THEN NULL ELSE coalesce(${t.endedAt}, excluded.ended_at) END`,
      },
      // THE throttle: an unchanged beat rewrites at most once per interval.
      setWhere: drizzleSql`true OR ${t.lastSeenAt} < now() - make_interval(secs => ${HEARTBEAT_REWRITE_SECONDS})
        OR ${t.state} IS DISTINCT FROM excluded.state
        OR ${t.subagentCount} IS DISTINCT FROM excluded.subagent_count
        OR (excluded.folder IS NOT NULL AND ${t.folder} IS DISTINCT FROM excluded.folder)
        OR (${t.endedAt} IS NULL) <> (excluded.ended_at IS NULL)`,
    })
    .returning({ id: t.id });

  const [row] = await database
    .select({
      id: t.id,
      computer: t.computer,
      harness: t.harness,
      conversationId: t.conversationId,
      state: t.state,
      stateSince: t.stateSince,
      endedAt: t.endedAt,
    })
    .from(t)
    .where(
      and(
        eq(t.userId, p.userId),
        eq(t.computer, hb.computer),
        eq(t.harness, hb.harness),
        eq(t.conversationId, hb.conversationId)
      )
    )
    .limit(1);
  if (!row) throw new Error("agent conversation upsert left no row");

  let sessionId: string | null = null;
  let sessionLinkSkipped: HeartbeatAnswer["sessionLinkSkipped"];
  if (hb.sessionId) {
    if (hb.ended) sessionLinkSkipped = "ended";
    else if (!p.apiKeyId) sessionLinkSkipped = "no_api_key";
    else {
      // The ONE runner door. Throttled there (one write a minute per row);
      // a throttled stamp still means the runner row exists.
      await stampSessionRunner({
        sessionId: hb.sessionId,
        ownerId: p.userId,
        agentUserId: p.agentUserId,
        identity: {
          clientKey: runnerClientKey(p.apiKeyId, hb.harness, hb.conversationId),
          cwd: null,
        },
      });
      sessionId = hb.sessionId;
    }
  }

  return {
    ok: true,
    answer: {
      conversation: {
        id: row.id,
        computer: row.computer,
        harness: row.harness,
        conversationId: row.conversationId,
        state: row.state,
        stateSince: row.stateSince.toISOString(),
        endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      },
      written: written.length > 0,
      sessionId,
      ...(sessionLinkSkipped ? { sessionLinkSkipped } : {}),
    },
  };
}

/** One open terminal, as `synap_list_agents` lists it under its computer. */
export interface LiveTerminal {
  /** The computer's normalised name (`normalizeComputerName`). */
  computer: string;
  /** The computer's principal when the reporting key's agent has one. */
  machineUserId: string | null;
  harness: string;
  conversationId: string;
  /** The working folder's basename. */
  folder: string | null;
  state: DecodedHeartbeat["state"];
  stateSince: string;
  subagents: number;
  lastSeenAt: string;
  agentUserId: string | null;
  /** The session it works in: its most recently stamped runner row. */
  sessionId: string | null;
}

/**
 * The bound session of the conversation row in scope: its newest runner row,
 * on the same person. Raw, fully qualified SQL on purpose: in a single-table
 * select Drizzle renders `${agentConversations.harness}` UNQUALIFIED, and an
 * unqualified `harness` inside the subquery binds to `session_runners` itself
 * — every conversation then "bound" to any runner (caught by the roster test).
 */
const boundSessionIdSql = drizzleSql<string | null>`(
  SELECT sr.session_id FROM session_runners sr
  WHERE sr.harness = harness
    AND sr.conversation_id = "agent_conversations"."conversation_id"
    AND sr.user_id = "agent_conversations"."user_id"
  ORDER BY sr.last_seen_at DESC
  LIMIT 1
)`;

/** Open, and heard from within the live window. */
const liveConversationWhere = () =>
  and(
    isNull(agentConversations.endedAt),
    drizzleSql`${agentConversations.lastSeenAt} >= now() - make_interval(secs => ${CONVERSATION_LIVE_WINDOW_SECONDS})`
  );

/**
 * The person's open terminals, most recently heard first. Owner-floored; a
 * failed read throws.
 */
export async function loadLiveTerminals(
  userId: string,
  opts: { limit?: number; database?: typeof db } = {}
): Promise<LiveTerminal[]> {
  const t = agentConversations;
  const rows = await (opts.database ?? db)
    .select({
      computer: t.computer,
      machineUserId: t.machineUserId,
      harness: t.harness,
      conversationId: t.conversationId,
      folder: t.folder,
      state: t.state,
      stateSince: t.stateSince,
      subagents: t.subagentCount,
      lastSeenAt: t.lastSeenAt,
      agentUserId: t.agentUserId,
      sessionId: boundSessionIdSql,
    })
    .from(t)
    .where(and(drizzleSql`${userId} IS NOT NULL`, liveConversationWhere()))
    .orderBy(desc(t.lastSeenAt))
    .limit(Math.max(1, Math.min(opts.limit ?? 100, 200)));
  return rows.map((r) => ({
    ...r,
    stateSince: new Date(r.stateSince).toISOString(),
    lastSeenAt: new Date(r.lastSeenAt).toISOString(),
    sessionId: r.sessionId ?? null,
  }));
}

/** A session's runner, joined to the terminal it runs in. */
export interface SessionRunnerTerminal {
  harness: string;
  conversationId: string;
  agentUserId: string | null;
  machineId: string | null;
  lastSeenAt: string;
  /**
   * Attached now: the runner was stamped within the runner window, or its
   * terminal is open and heard from within the conversation window.
   */
  live: boolean;
  /** The terminal's own facts; null when no terminal of the VIEWER reports it. */
  terminal: {
    computer: string;
    folder: string | null;
    state: DecodedHeartbeat["state"];
    stateSince: string;
    subagents: number;
    lastSeenAt: string;
    ended: boolean;
  } | null;
}

/** Runners kept per session on a list row (newest first). */
export const LIST_RUNNERS_PER_SESSION = 10;

/**
 * The runners of each session in `sessionIds`, each joined to its terminal.
 * The CALLER floors the sessions (the list door read them through the session
 * rule). The terminal join floors on the runner's person AND `viewerId`: a member of a shared session
 * sees who is attached, never the owner's computers or folders. Throws on a
 * failed read.
 */
export async function loadSessionRunnerTerminals(
  sessionIds: readonly string[],
  viewerId: string,
  opts: { now?: Date; database?: typeof db } = {}
): Promise<Map<string, SessionRunnerTerminal[]>> {
  const out = new Map<string, SessionRunnerTerminal[]>();
  const ids = [...new Set(sessionIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const now = (opts.now ?? new Date()).getTime();
  const sr = sessionRunners;
  const t = agentConversations;
  const rows = await (opts.database ?? db)
    .select({
      sessionId: sr.sessionId,
      clientKey: sr.clientKey,
      harness: sr.harness,
      conversationId: sr.conversationId,
      agentUserId: sr.agentUserId,
      machineId: sr.machineUserId,
      runnerSeenAt: sr.lastSeenAt,
      computer: t.computer,
      folder: t.folder,
      state: t.state,
      stateSince: t.stateSince,
      subagents: t.subagentCount,
      terminalSeenAt: t.lastSeenAt,
      endedAt: t.endedAt,
    })
    .from(sr)
    .leftJoin(
      t,
      and(
        eq(t.harness, sr.harness),
        eq(t.conversationId, sr.conversationId),
        // The runner's person, and only when that is the viewer.
        drizzleSql`${viewerId} IS NOT NULL`
      )
    )
    .where(inArray(sr.sessionId, ids))
    .orderBy(desc(sr.lastSeenAt), desc(t.lastSeenAt));

  const seen = new Set<string>();
  for (const r of rows) {
    // One runner can meet two terminal rows (one conversation id reported
    // from two computers): the newest terminal wins (ordered above).
    const key = `${r.sessionId}\u0000${r.clientKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = out.get(r.sessionId) ?? [];
    if (list.length >= LIST_RUNNERS_PER_SESSION) continue;
    const runnerSeen = new Date(r.runnerSeenAt).getTime();
    const terminal =
      r.computer && r.state && r.stateSince && r.terminalSeenAt
        ? {
            computer: r.computer,
            folder: r.folder ?? null,
            state: r.state,
            stateSince: new Date(r.stateSince).toISOString(),
            subagents: r.subagents ?? 0,
            lastSeenAt: new Date(r.terminalSeenAt).toISOString(),
            ended: r.endedAt != null,
          }
        : null;
    const terminalLive =
      !!terminal &&
      !terminal.ended &&
      now - Date.parse(terminal.lastSeenAt) <=
        CONVERSATION_LIVE_WINDOW_SECONDS * 1000;
    list.push({
      harness: r.harness,
      conversationId: r.conversationId,
      agentUserId: r.agentUserId,
      machineId: r.machineId,
      lastSeenAt: new Date(r.runnerSeenAt).toISOString(),
      live:
        now - runnerSeen <= RUNNER_LIVE_WINDOW_SECONDS * 1000 || terminalLive,
      terminal,
    });
    out.set(r.sessionId, list);
  }
  return out;
}
