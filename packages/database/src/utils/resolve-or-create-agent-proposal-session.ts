/**
 * Resolve or create the session an agent's write is filed under when the write
 * arrived without one — the session-first DEFAULT (never enforcement: a write
 * is never refused for lacking a session; this only groups it).
 *
 * Reuse ladder — keyed on the CALLING CLIENT, never on the per-write goal:
 *  1. Existing session with the same correlationId (when caller set a stable one)
 *  2. The client's own session (`findClientSession`): the one it started itself
 *     (start_session stamps `metadata.clientKey`), else the one this door
 *     auto-opened for it FOR THIS WRITE'S PROJECT while it is still in its
 *     activity window
 *  3. Auto-open one via openRunSession — a RECEIPT (`metadata.kind =
 *     'agent-proposal-package'`), marked `autoOpened` + `clientKey`, named by the
 *     caller (`buildDerivedSessionTitle`, titleSource "derived"). Minted under a
 *     per-client advisory lock so a concurrent burst opens ONE.
 *
 * Grouping used to key on the exact derived goal ("Create task Buy milk"), so N
 * different writes made N receipts and nothing ever closed them. One client's
 * working stretch is one receipt PER PROJECT now (B4 2026-10-21: a receipt is
 * the pod's guess, so it splits where the work's project changes — live, one
 * receipt swallowed 142 writes across six spaces). A session the client
 * STARTED never splits: it stays bound whatever the write's project (the MCP
 * door hints instead). The hourly reaper closes a receipt once it has been
 * idle for {@link RECEIPT_IDLE_WINDOW_HOURS} with nothing pending.
 *
 * Never calls createFocusSession (that proposes → recursion / null id).
 * Humans (no agentUserId) never enter this helper — callers must gate.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { workspaces } from "../schema/workspaces.js";
import { openRunSession } from "./open-run-session.js";
import {
  clientKeyScope,
  conversationCwdPatch,
  getRequestClientKey,
} from "./request-write-context.js";

/** The receipt marker (read by the session-kind projection in @synap/api). */
export const AGENT_PROPOSAL_PACKAGE_MARKER = "agent-proposal-package";

/**
 * An auto-opened session stays the client's current one while it saw activity
 * (a row touch or a proposal filed under it) within this window. The reaper
 * closes an auto-opened receipt idle this long with nothing pending — the two
 * read the same number so "reusable" and "closable" can never overlap.
 */
export const RECEIPT_IDLE_WINDOW_HOURS = 2;

export interface ResolveOrCreateAgentProposalSessionInput {
  userId: string;
  agentUserId: string;
  /** What this write is doing — the auto-opened session's goal. */
  goal: string;
  /** Display name for an auto-opened session (caller builds it; no ids). */
  title?: string | null;
  workspaceId?: string | null;
  projectId?: string | null;
  /**
   * WHO is calling. Absent ⇒ the request's key-auth client
   * (`getRequestClientKey`), else the channel, else the agent — see
   * {@link resolveClientKey}.
   */
  clientKey?: string | null;
  /** The channel the write came through (IS turns), a fallback client key. */
  channelId?: string | null;
  /** Only reuse/bind when the caller already had a stable chain id — not a
   *  fresh per-proposal UUID that would force one session per row. */
  correlationId?: string | null;
  /** When true, treat correlationId as stable and prefer it for reuse. */
  stableCorrelation?: boolean;
}

/**
 * The ONE goal normalization: collapse whitespace, trim, cap at 240. Exported
 * because the session dedup door (`findOpenSessionTwin` in @synap/api) compares
 * goals with it — a second normalizer would let two doors disagree on "same".
 */
export function normalizeGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * The client a write groups under: explicit › the request's key-auth client ›
 * the channel it came through › the agent itself.
 */
export function resolveClientKey(input: {
  clientKey?: string | null;
  channelId?: string | null;
  agentUserId: string;
}): string {
  return (
    input.clientKey ||
    getRequestClientKey() ||
    (input.channelId
      ? `channel:${input.channelId}`
      : `agent:${input.agentUserId}`)
  );
}

/** Statuses a client's current session may hold (`scheduled` is a future slot). */
const CLIENT_SESSION_STATUSES = ["active", "paused", "forming"] as const;

export interface ClientSession {
  id: string;
  /** True when this door auto-opened it (not started by the client itself). */
  autoOpened: boolean;
  /** Its project — a receipt's KEY half (B4); null = the no-project receipt. */
  projectId: string | null;
}

/**
 * When a session last saw activity: its own row touch, or the newest proposal
 * filed under it. ONE definition of "touched", read by the receipt window here
 * and by the open-sessions count the MCP note prints, so "idle" and "touched in
 * the last 24 hours" cannot disagree about one row.
 */
export function sessionLastActivitySql() {
  return sql`greatest(${focusSessions.updatedAt}, coalesce((select max(p.created_at) from proposals p where p.session_id = ${focusSessions.id}), ${focusSessions.updatedAt}))`;
}

/**
 * The session bound to THIS client, or null. A session the client STARTED
 * (start_session stamps `metadata.clientKey`) wins over one this door
 * auto-opened for it; an auto-opened one only counts while it is inside its
 * activity window. `onlyAutoOpened` narrows to the latter (start_session's
 * adoption lookup).
 *
 * KEY-scoped clients (option A — no conversation id, see `clientKeyForApiKey`)
 * are ALWAYS narrowed to auto-opened: a STARTED session stamped `key:<id>`
 * belongs to one of the many conversations sharing that key, and joining it
 * without naming it is the accidental sharing this rule forbids.
 *
 * `projectId` (B4): when given — `null` included, the "no project" key — an
 * AUTO-OPENED session counts only if it is that project's receipt. A started
 * session is unaffected. Omitted ⇒ any project (the attribution read and the
 * MCP door, which do not know the write's project yet).
 */
export async function findClientSession(
  userId: string,
  clientKey: string,
  opts: {
    onlyAutoOpened?: boolean;
    database?: Pick<typeof db, "select">;
    projectId?: string | null;
  } = {}
): Promise<ClientSession | null> {
  const database = opts.database ?? db;
  const onlyAutoOpened =
    opts.onlyAutoOpened === true || clientKeyScope(clientKey) === "key";
  const autoOpened = sql`coalesce((${focusSessions.metadata} ->> 'autoOpened')::boolean, false)`;
  const rows = await database
    .select({
      id: focusSessions.id,
      autoOpened: sql<boolean>`${autoOpened}`,
      projectId: focusSessions.projectId,
    })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        inArray(focusSessions.status, [...CLIENT_SESSION_STATUSES]),
        sql`${focusSessions.metadata} ->> 'clientKey' = ${clientKey}`,
        onlyAutoOpened ? sql`${autoOpened}` : undefined,
        // An auto-opened session is the client's CURRENT one only while it saw
        // activity inside the window; one it started itself stays bound until
        // it is closed.
        sql`(NOT ${autoOpened} OR ${sessionLastActivitySql()} > now() - (${RECEIPT_IDLE_WINDOW_HOURS}::int * interval '1 hour'))`,
        // A receipt is per (client, project); a started session is not.
        opts.projectId !== undefined
          ? sql`(NOT ${autoOpened} OR ${focusSessions.projectId} IS NOT DISTINCT FROM ${opts.projectId})`
          : undefined
      )
    )
    .orderBy(sql`${autoOpened} asc`, desc(focusSessions.startedAt))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        autoOpened: row.autoOpened === true,
        projectId: row.projectId ?? null,
      }
    : null;
}

/**
 * The space an auto-opened receipt is stamped with: the write's space, unless
 * that space is ARCHIVED — then none (pod-level). A receipt groups a client's
 * writes; it is not a placement, and every later write of the conversation is
 * filed under it, so stamping an archived space buried a whole working stretch
 * in a space nobody lists (live 2026-10-20: an agent moving items OUT of the
 * archived "Radar" opened its receipt IN Radar). An id with no row is kept as
 * given — this only refuses what is provably archived.
 */
async function receiptWorkspaceId(
  database: Pick<typeof db, "select">,
  workspaceId: string | null | undefined
): Promise<string | null> {
  if (!workspaceId) return null;
  const [row] = await database
    .select({ archivedAt: workspaces.archivedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row?.archivedAt != null ? null : workspaceId;
}

export async function resolveOrCreateAgentProposalSession(
  input: ResolveOrCreateAgentProposalSessionInput
): Promise<string | null> {
  const goal = normalizeGoal(input.goal);
  if (!goal) return null;
  const clientKey = resolveClientKey(input);

  try {
    // 1) Stable correlation → existing session
    if (input.stableCorrelation && input.correlationId) {
      const byCorr = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.correlationId, input.correlationId),
          eq(focusSessions.userId, input.userId),
          ...(input.workspaceId
            ? [eq(focusSessions.workspaceId, input.workspaceId)]
            : [])
        ),
        columns: { id: true },
      });
      if (byCorr) return byCorr.id;
    }

    // 2) The client's own session: one it started, else ITS receipt for this
    // write's project (`null` = the no-project receipt).
    const projectId = input.projectId ?? null;
    const bound = await findClientSession(input.userId, clientKey, {
      projectId,
    });
    if (bound) return bound.id;

    // 3) Auto-open, serialized per client: the lock is held until this
    // transaction ends, so a concurrent resolver for the same client waits,
    // then re-reads (READ COMMITTED sees the row the winner committed) and
    // reuses it instead of opening a second one.
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`receipt|${input.userId}|${clientKey}|${projectId ?? ""}`}))`
      );
      const raced = await findClientSession(input.userId, clientKey, {
        database: tx,
        projectId,
      });
      if (raced) return raced.id;
      // Inserted on the tx: the lock and the insert share one connection.
      const opened = await openRunSession({
        database: tx as unknown as typeof db,
        userId: input.userId,
        agentUserId: input.agentUserId,
        workspaceId: await receiptWorkspaceId(tx, input.workspaceId),
        projectId,
        goal,
        title: input.title ?? null,
        source: "agent-write",
        extraMetadata: {
          kind: AGENT_PROPOSAL_PACKAGE_MARKER,
          autoOpened: true,
          clientKey,
          ...conversationCwdPatch(clientKey),
          ...(input.stableCorrelation && input.correlationId
            ? { correlationId: input.correlationId }
            : {}),
        },
      });
      return opened.sessionId;
    });
  } catch {
    // Best-effort — never block the proposal write if session mint fails.
    return null;
  }
}

/** Derive a short goal string from proposal insert fields. */
export function deriveAgentProposalSessionGoal(input: {
  data?: Record<string, unknown> | null;
  proposalType?: string;
  targetType?: string;
  notificationDescription?: string | null;
  /**
   * The proposal's OWN summary — the one sentence the reviewer reads on the
   * detail and the pack row. Ranked directly ABOVE the `Agent <type> · <target>`
   * fallback, so a caller that has it never files a receipt session titled with
   * two raw DB tokens ("Agent renderer.set · profile"), and every caller that
   * does not is byte-identical to before.
   *
   * Deliberately BELOW `data.summary` / `notificationDescription` / `data.goal`
   * / `data.reasoning`: those are the author's own words about this write, and
   * a synthesized sentence must never displace them.
   */
  summary?: string | null;
}): string {
  const data = input.data ?? {};
  const fromSummary =
    typeof data.summary === "string" ? data.summary.trim() : "";
  if (fromSummary) return normalizeGoal(fromSummary);
  const fromNotify = input.notificationDescription?.trim();
  if (fromNotify) return normalizeGoal(fromNotify);
  const fromGoal = typeof data.goal === "string" ? data.goal.trim() : "";
  if (fromGoal) return normalizeGoal(fromGoal);
  const fromReasoning =
    typeof data.reasoning === "string" ? data.reasoning.trim() : "";
  if (fromReasoning) return normalizeGoal(fromReasoning.slice(0, 160));
  const fromSummaryArg = input.summary?.trim();
  if (fromSummaryArg) return normalizeGoal(fromSummaryArg);
  const type = input.proposalType?.trim() || "write";
  const target = input.targetType?.trim() || "entity";
  return normalizeGoal(`Agent ${type} · ${target}`);
}
