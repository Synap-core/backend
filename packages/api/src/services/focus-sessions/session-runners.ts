/**
 * Session runners (0342) — WHO IS ATTACHED to a session right now.
 *
 * A runner is a client conversation that holds the session's change-feed wait
 * (`waitForSessionChanges` / `waitForSessionAnswers`, i.e. MCP
 * `synap_wait_for_answer` and Hub `GET /focus-sessions/:id/answers/wait`)
 * while naming its OWN conversation — `X-Synap-Conversation:
 * <harness>:<id>`, which both key-auth doors fold into the request's client key
 * `key:<apiKeyId>|conv:<harness>:<id>` (`clientKeyForApiKey`). A Claude Code
 * session bound by synap-bridge is the first such client.
 *
 * WRITE: {@link stampSessionRunner}, called by the wait itself. Telemetry like
 * `api_keys.last_used_at` — no governance proposal: it records that a client
 * was listening and changes nothing a person owns. At most ONE write a minute
 * per (session, client key), enforced in SQL (the upsert's `WHERE`), so a
 * watcher looping 50-second waits costs one row write a minute. It never
 * touches `focus_sessions`: 0277's row trigger would NOTIFY the session channel
 * and wake the very wait that stamped it. A failed stamp is logged, never
 * thrown — presence is not worth failing the wait over.
 *
 * READ: {@link loadSessionRunners}. Keyed by session id only: its caller has
 * already read the session through its own floor (the continuation packet,
 * its one caller). The access-layer rule for the table is
 * `sessionRunnerReadableWhere` (`access/registry.ts`).
 *
 * A runner row carries the session's `clientKey` + `cwd` shape, so the ONE
 * resume derivation (`resolveAgentConversation`, @synap-core/types/agents)
 * reads it as it reads a session's metadata — never a second resume rule.
 */

import {
  db,
  sessionRunners,
  users,
  eq,
  desc,
  drizzleSql,
  getRequestClientKey,
  getRequestConversationCwd,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  resolveAgentConversation,
  type AgentConversationRef,
} from "@synap-core/types/agents";

const logger = createLogger({ module: "session-runners" });

/** The most often a runner row is written (per session × client key). */
export const RUNNER_STAMP_INTERVAL_SECONDS = 60;

/**
 * How long after its last stamp a runner still reads as live. A watcher that
 * keeps re-waiting is stamped every {@link RUNNER_STAMP_INTERVAL_SECONDS}; one
 * 90-second wait (the max) plus the gap before the next fits inside this.
 */
export const RUNNER_LIVE_WINDOW_SECONDS = 150;

/** `key:<uuid>|conv:<conversation>` — the client key a key-auth door sets. */
const CLIENT_KEY_RE = /^key:([0-9a-f-]{36})\|conv:(.+)$/i;
/** A conversation the client NAMED: `<harness>:<id>` (the pod-minted
 *  `Mcp-Session-Id` fallback carries no harness prefix, so it never matches). */
const NAMED_CONVERSATION_RE = /^([a-z][a-z0-9-]{0,31}):(.+)$/;

export interface ParsedRunnerKey {
  apiKeyId: string;
  harness: string;
  conversationId: string;
}

/**
 * The runner identity in a client key, or null when the client did not name
 * its own conversation (key scope, an IS channel, a pod-minted MCP session id).
 */
export function parseRunnerClientKey(
  clientKey: string | null | undefined
): ParsedRunnerKey | null {
  const key = CLIENT_KEY_RE.exec(clientKey ?? "");
  if (!key) return null;
  const conv = NAMED_CONVERSATION_RE.exec(key[2]!);
  if (!conv) return null;
  return {
    apiKeyId: key[1]!.toLowerCase(),
    harness: conv[1]!,
    conversationId: conv[2]!,
  };
}

/**
 * Record that THIS request's client conversation holds `sessionId`'s wait.
 * Reads the client key and cwd the key-auth door entered for the request; a
 * request with no named conversation stamps nothing. Returns whether a row was
 * written (false = nothing to stamp, or throttled). Never throws.
 */
export async function stampSessionRunner(p: {
  sessionId: string;
  /** The session owner (the wait's floor already proved it reads the session). */
  ownerId: string;
  /** The agent acting through the key, when an agent key is calling. */
  agentUserId?: string | null;
}): Promise<boolean> {
  const clientKey = getRequestClientKey();
  const parsed = parseRunnerClientKey(clientKey);
  if (!clientKey || !parsed) return false;
  const cwd = getRequestConversationCwd() ?? null;
  const agentUserId = p.agentUserId ?? null;
  try {
    // The computer: the agent's host (`users.host_user_id`), or the agent
    // itself when the key belongs to a `machine` agent user.
    const machine = agentUserId
      ? drizzleSql`(SELECT CASE WHEN ${users.agentType} = 'machine' THEN ${users.id} ELSE ${users.hostUserId} END FROM ${users} WHERE ${users.id} = ${agentUserId})`
      : drizzleSql`NULL`;
    const written = await db
      .insert(sessionRunners)
      .values({
        sessionId: p.sessionId,
        clientKey,
        userId: p.ownerId,
        agentUserId,
        apiKeyId: parsed.apiKeyId,
        harness: parsed.harness,
        conversationId: parsed.conversationId,
        cwd,
        machineUserId: machine,
      })
      .onConflictDoUpdate({
        target: [sessionRunners.sessionId, sessionRunners.clientKey],
        set: {
          lastSeenAt: drizzleSql`now()`,
          cwd: drizzleSql`coalesce(excluded.cwd, ${sessionRunners.cwd})`,
          agentUserId: drizzleSql`excluded.agent_user_id`,
          machineUserId: drizzleSql`coalesce(excluded.machine_user_id, ${sessionRunners.machineUserId})`,
        },
        // THE throttle: at most one write a minute per row.
        setWhere: drizzleSql`${sessionRunners.lastSeenAt} < now() - make_interval(secs => ${RUNNER_STAMP_INTERVAL_SECONDS})`,
      })
      .returning({ sessionId: sessionRunners.sessionId });
    return written.length > 0;
  } catch (err) {
    logger.warn(
      { err, sessionId: p.sessionId },
      "session runner stamp failed (non-fatal)"
    );
    return false;
  }
}

export interface SessionRunner {
  harness: string;
  conversationId: string;
  cwd: string | null;
  agentUserId: string | null;
  /** The computer hosting the agent (`users.id` of a `machine` agent user). */
  machineUserId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Stamped within {@link RUNNER_LIVE_WINDOW_SECONDS} of `now`. */
  live: boolean;
  /** The reopen door (`claude --resume …`), or null for a harness we cannot reopen. */
  conversation: AgentConversationRef | null;
}

/**
 * The runners attached to a session, most recently seen first. Keyed by
 * session id only — the caller has read the session through its own floor. A
 * failed read THROWS (an empty list would read as "nobody is attached").
 */
export async function loadSessionRunners(
  sessionId: string,
  opts: { now?: Date; limit?: number; database?: typeof db } = {}
): Promise<SessionRunner[]> {
  const now = (opts.now ?? new Date()).getTime();
  const rows = await (opts.database ?? db)
    .select({
      clientKey: sessionRunners.clientKey,
      harness: sessionRunners.harness,
      conversationId: sessionRunners.conversationId,
      cwd: sessionRunners.cwd,
      agentUserId: sessionRunners.agentUserId,
      machineUserId: sessionRunners.machineUserId,
      firstSeenAt: sessionRunners.firstSeenAt,
      lastSeenAt: sessionRunners.lastSeenAt,
    })
    .from(sessionRunners)
    .where(eq(sessionRunners.sessionId, sessionId))
    .orderBy(desc(sessionRunners.lastSeenAt))
    .limit(Math.max(1, Math.min(opts.limit ?? 20, 100)));
  return rows.map((r) => ({
    harness: r.harness,
    conversationId: r.conversationId,
    cwd: r.cwd,
    agentUserId: r.agentUserId,
    machineUserId: r.machineUserId,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    live: now - r.lastSeenAt.getTime() <= RUNNER_LIVE_WINDOW_SECONDS * 1000,
    conversation: resolveAgentConversation({
      clientKey: r.clientKey,
      conversationCwd: r.cwd,
    }),
  }));
}
