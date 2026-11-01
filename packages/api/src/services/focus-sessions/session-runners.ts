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
 * A runner is a conversation's OS PROCESS (0373): the client names its process
 * (`X-Synap-Process: <host>:<pid>:<startedAtMs>`), the primary key carries it,
 * and two live copies of one conversation are two rows. A client that names no
 * process keeps the one row per (session, client key) it always had
 * (`process_key = ''`); that row is never read as a twin. SIGNAL ONLY: nothing
 * here refuses a write or a wait ({@link markTwins}).
 *
 * A runner SAYS WHAT IT IS DOING (0384): `busy`, `idle`, `needs_permission`
 * or `ended`, named by any harness adapter on ANY key-auth call
 * (`X-Synap-Runner-State`, or `_meta["live.synap/runnerState"]` on MCP;
 * `RUNNER_STATES`, `request-write-context.ts`). ONE door, two writes:
 *   - the wait's stamp records it with the row ({@link stampSessionRunner});
 *     a state that changed is written at once, past the once-a-minute throttle;
 *   - every other call that carries it updates that conversation's process
 *     rows while they are live ({@link reportRunnerState}, called by both
 *     key-auth doors, off the request path) — so a turn that ends while the
 *     wait is held still reads `idle` within one call, not a minute.
 * `state_reported_at` orders reports: an older one (a 90-second wait's
 * re-stamp carries the state it was opened with) never overwrites a newer one.
 * Same posture as the stamp: telemetry, no governance, never thrown.
 * READ: a runner past the live window, or one that said `ended`, reads
 * `ended` and not live; a live one whose client names no state reads `null`
 * (unknown, never "idle"). {@link foldRunnerState} is the session-level word.
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
  getRequestProcess,
  getRequestRunnerState,
  and,
  isNull,
  lt,
  or,
  RUNNER_STATES,
  type RunnerState,
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
  /**
   * When the wait that stamps was OPENED. A runner that said `ended` before
   * then has come back (a resumed conversation waits again): its `ended` is
   * cleared — to the state this wait names, else unknown (`null`). A wait
   * opened before the `ended` (its re-stamp a minute later) never revives it.
   * Absent: nothing is revived.
   */
  waitOpenedAt?: Date;
}): Promise<boolean> {
  const clientKey = getRequestClientKey();
  const parsed = parseRunnerClientKey(clientKey);
  if (!clientKey || !parsed) return false;
  const cwd = getRequestConversationCwd() ?? null;
  const proc = getRequestProcess();
  const report = getRequestRunnerState();
  const agentUserId = p.agentUserId ?? null;
  // The report is newer than the row's: it may move the state (0384).
  const fresher = drizzleSql`(excluded.state IS NOT NULL AND (${sessionRunners.stateReportedAt} IS NULL OR excluded.state_reported_at > ${sessionRunners.stateReportedAt}))`;
  // The runner said `ended`, and this wait was opened after it said so: it
  // is back. Without a state of its own the row reads unknown, never `ended`.
  const opened = p.waitOpenedAt ?? null;
  const revived = opened
    ? drizzleSql`(${sessionRunners.state} = 'ended' AND (${sessionRunners.stateReportedAt} IS NULL OR ${sessionRunners.stateReportedAt} < ${opened.toISOString()}::timestamptz) AND NOT ${fresher})`
    : drizzleSql`false`;
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
        processKey: proc?.key ?? "",
        processHost: proc?.host ?? null,
        processStartedAt: proc?.startedAt ?? null,
        state: report?.state ?? null,
        stateSince: report?.reportedAt ?? null,
        stateReportedAt: report?.reportedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [
          sessionRunners.sessionId,
          sessionRunners.clientKey,
          sessionRunners.processKey,
        ],
        set: {
          lastSeenAt: drizzleSql`now()`,
          cwd: drizzleSql`coalesce(excluded.cwd, ${sessionRunners.cwd})`,
          agentUserId: drizzleSql`excluded.agent_user_id`,
          machineUserId: drizzleSql`coalesce(excluded.machine_user_id, ${sessionRunners.machineUserId})`,
          state: drizzleSql`CASE WHEN ${fresher} THEN excluded.state WHEN ${revived} THEN NULL ELSE ${sessionRunners.state} END`,
          stateSince: drizzleSql`CASE WHEN ${fresher} AND excluded.state IS DISTINCT FROM ${sessionRunners.state} THEN excluded.state_since WHEN ${revived} THEN now() ELSE ${sessionRunners.stateSince} END`,
          stateReportedAt: drizzleSql`CASE WHEN ${fresher} THEN excluded.state_reported_at WHEN ${revived} THEN now() ELSE ${sessionRunners.stateReportedAt} END`,
        },
        // THE throttle: at most one write a minute per row — unless the
        // runner says something new, or came back, which is written at once.
        setWhere: drizzleSql`${sessionRunners.lastSeenAt} < now() - make_interval(secs => ${RUNNER_STAMP_INTERVAL_SECONDS}) OR (${fresher} AND excluded.state IS DISTINCT FROM ${sessionRunners.state}) OR ${revived}`,
      })
      .returning({ sessionId: sessionRunners.sessionId });
    // The row may have moved (a revived `ended`): the next report is news.
    if (written.length > 0) {
      lastReported.delete(`${clientKey}\u0000${proc?.key ?? ""}`);
    }
    return written.length > 0;
  } catch (err) {
    logger.warn(
      { err, sessionId: p.sessionId },
      "session runner stamp failed (non-fatal)"
    );
    return false;
  }
}

/**
 * Record what THIS request's runner says it is doing (0384) on its process's
 * LIVE rows — every session whose wait it holds — when the state differs and
 * the report is newer. Both key-auth doors call it on every request, off the
 * request path; a request that names no state, or no conversation, costs no
 * query. The wait's own stamp creates the row: a runner that never waited has
 * no row to update. Returns how many rows moved. Never throws.
 */
export async function reportRunnerState(
  opts: { database?: typeof db; nowMs?: number } = {}
): Promise<number> {
  try {
    const report = getRequestRunnerState();
    const clientKey = getRequestClientKey();
    if (!report || !clientKey || !parseRunnerClientKey(clientKey)) return 0;
    const processKey = getRequestProcess()?.key ?? "";
    // The debounce: a runner repeats its state on EVERY call; the same word
    // from the same process inside the window costs no query.
    const debounceKey = `${clientKey}\u0000${processKey}`;
    const nowMs = opts.nowMs ?? Date.now();
    const last = lastReported.get(debounceKey);
    if (
      last &&
      last.state === report.state &&
      nowMs - last.at < RUNNER_REPORT_DEBOUNCE_MS
    ) {
      return 0;
    }
    rememberReport(debounceKey, report.state, nowMs);
    const moved = await (opts.database ?? db)
      .update(sessionRunners)
      .set({
        state: report.state,
        stateSince: report.reportedAt,
        stateReportedAt: report.reportedAt,
      })
      .where(
        and(
          eq(sessionRunners.clientKey, clientKey),
          eq(sessionRunners.processKey, processKey),
          drizzleSql`${sessionRunners.lastSeenAt} > now() - make_interval(secs => ${RUNNER_LIVE_WINDOW_SECONDS})`,
          drizzleSql`${sessionRunners.state} IS DISTINCT FROM ${report.state}`,
          or(
            isNull(sessionRunners.stateReportedAt),
            lt(sessionRunners.stateReportedAt, report.reportedAt)
          )
        )
      )
      .returning({ sessionId: sessionRunners.sessionId });
    return moved.length;
  } catch (err) {
    // Called with `void` by the doors: it must never reject. A failed write
    // must not be debounced: the next call tries again.
    lastReported.clear();
    logger.warn({ err }, "runner state report failed (non-fatal)");
    return 0;
  }
}

/**
 * How long one process's repeated report of the SAME state is skipped
 * ({@link reportRunnerState}). A missed move is caught within this window, or
 * at once by the wait's own stamp; a CHANGED state is never debounced.
 */
export const RUNNER_REPORT_DEBOUNCE_MS = 30_000;
/** Debounce entries kept per pod process (oldest dropped first). */
const RUNNER_REPORT_DEBOUNCE_MAX = 5_000;

/** client key + process → the last state reported and when (this pod process only). */
const lastReported = new Map<string, { state: RunnerState; at: number }>();

function rememberReport(key: string, state: RunnerState, at: number): void {
  lastReported.delete(key);
  lastReported.set(key, { state, at });
  if (lastReported.size > RUNNER_REPORT_DEBOUNCE_MAX) {
    const oldest = lastReported.keys().next().value;
    if (oldest !== undefined) lastReported.delete(oldest);
  }
}

/** Test seam: forget every debounced report. */
export function resetRunnerReportDebounce(): void {
  lastReported.clear();
}

/** One other live copy of the same conversation (0373). */
export interface TwinCopy {
  /** The copy's `X-Synap-Process` value — what a client compares to its own. */
  processId: string;
  host: string | null;
  startedAt: string | null;
  lastSeenAt: string;
}

export interface SessionRunner {
  harness: string;
  conversationId: string;
  cwd: string | null;
  agentUserId: string | null;
  /** The computer hosting the agent (`users.id` of a `machine` agent user). */
  machineUserId: string | null;
  /** The OS process holding the wait (`<host>:<pid>:<startedAtMs>`); '' when its client named none. */
  processId: string;
  /** That process's host and start time, as it named itself. */
  processHost: string | null;
  processStartedAt: string | null;
  /**
   * The OTHER live copies of this conversation on this session (never this
   * row); empty when there is no twin. Only rows that named a process count.
   */
  twin: TwinCopy[];
  /**
   * What it says it is doing (0384). `ended` when it said so, or when it left
   * the live window; `null` while live = its client names no state (unknown).
   */
  state: RunnerState | null;
  /** When it entered that state (for a runner gone quiet: when it was last seen). */
  stateSince: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Stamped within {@link RUNNER_LIVE_WINDOW_SECONDS} of `now`, and not `ended`. */
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
      processKey: sessionRunners.processKey,
      processHost: sessionRunners.processHost,
      processStartedAt: sessionRunners.processStartedAt,
      state: sessionRunners.state,
      stateSince: sessionRunners.stateSince,
      firstSeenAt: sessionRunners.firstSeenAt,
      lastSeenAt: sessionRunners.lastSeenAt,
    })
    .from(sessionRunners)
    .where(eq(sessionRunners.sessionId, sessionId))
    .orderBy(desc(sessionRunners.lastSeenAt))
    .limit(Math.max(1, Math.min(opts.limit ?? 20, 100)));
  return markTwins(
    rows.map((r) => {
      const said = parseStoredState(r.state);
      const live =
        said !== "ended" &&
        now - r.lastSeenAt.getTime() <= RUNNER_LIVE_WINDOW_SECONDS * 1000;
      return {
        harness: r.harness,
        conversationId: r.conversationId,
        cwd: r.cwd,
        agentUserId: r.agentUserId,
        machineUserId: r.machineUserId,
        processId: r.processKey,
        processHost: r.processHost,
        processStartedAt: r.processStartedAt?.toISOString() ?? null,
        twin: [],
        state: live ? said : "ended",
        stateSince:
          live || said === "ended"
            ? (r.stateSince?.toISOString() ?? null)
            : r.lastSeenAt.toISOString(),
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        live,
        conversation: resolveAgentConversation({
          clientKey: r.clientKey,
          conversationCwd: r.cwd,
        }),
      };
    })
  );
}

/** A stored state the pod knows, else null (a row from before 0384, or a word dropped since). */
function parseStoredState(raw: string | null): RunnerState | null {
  return RUNNER_STATES.find((s) => s === raw) ?? null;
}

/** What a session's runners say, folded: the most urgent word among the LIVE ones. */
export interface RunnerStateFold {
  /** `needs_permission` over `busy` over `idle`; null = no live runner named a state. */
  state: Exclude<RunnerState, "ended"> | null;
  /** When the longest-standing runner in that state entered it. */
  since: string | null;
}

const FOLD_ORDER = ["needs_permission", "busy", "idle"] as const;

/**
 * THE session-level runner word: a person waiting on a permission dialog
 * outranks an agent at work, which outranks one at rest. Only live runners
 * count (an ended one says nothing about now). Pure.
 */
export function foldRunnerState(runners: SessionRunner[]): RunnerStateFold {
  for (const state of FOLD_ORDER) {
    const inState = runners.filter((r) => r.live && r.state === state);
    if (inState.length === 0) continue;
    const since = inState
      .map((r) => r.stateSince)
      .filter((s): s is string => s !== null)
      .sort()[0];
    return { state, since: since ?? null };
  }
  return { state: null, since: null };
}

/**
 * Mark a twin: two LIVE runners of one conversation (same harness and id, case
 * folded) whose processes differ. A runner with no process (`processId ''`: a
 * legacy client, or a row from before 0373) never counts — it cannot be told
 * apart from the copy that sent the header. A stale copy is history, not a
 * twin. Pure; the rows come back with `twin` filled.
 */
export function markTwins(runners: SessionRunner[]): SessionRunner[] {
  const groups = new Map<string, SessionRunner[]>();
  for (const r of runners) {
    if (!r.live || r.processId === "") continue;
    const k = `${r.harness}:${r.conversationId.toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return runners.map((r) => {
    if (!r.live || r.processId === "") return r;
    const group =
      groups.get(`${r.harness}:${r.conversationId.toLowerCase()}`) ?? [];
    const others = group.filter((o) => o.processId !== r.processId);
    return others.length === 0
      ? r
      : {
          ...r,
          twin: others.map((o) => ({
            processId: o.processId,
            host: o.processHost,
            startedAt: o.processStartedAt,
            lastSeenAt: o.lastSeenAt,
          })),
        };
  });
}
