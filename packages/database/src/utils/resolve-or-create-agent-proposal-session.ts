/**
 * Resolve or create the session an agent's write is filed under when the write
 * arrived without one — the session-first DEFAULT (never enforcement: a write
 * is never refused for lacking a session; this only groups it).
 *
 * Reuse ladder — keyed on the CALLING CLIENT, never on the per-write goal:
 *  1. Existing session with the same correlationId (when caller set a stable one)
 *  2. The client's own session (`findClientSession`): the one it started itself
 *     (start_session stamps `metadata.clientKey`), else the one this door
 *     auto-opened for it while it is still in its activity window
 *  3. Auto-open one via openRunSession — a RECEIPT (`metadata.kind =
 *     'agent-proposal-package'`), marked `autoOpened` + `clientKey`, named by the
 *     caller (`buildDerivedSessionTitle`, titleSource "derived"). Minted under a
 *     per-client advisory lock so a concurrent burst opens ONE.
 *
 * Grouping used to key on the exact derived goal ("Create task Buy milk"), so N
 * different writes made N receipts and nothing ever closed them. One client's
 * working stretch is one receipt now; the hourly reaper closes it once it has
 * been idle for {@link RECEIPT_IDLE_WINDOW_HOURS} with nothing pending.
 *
 * Never calls createFocusSession (that proposes → recursion / null id).
 * Humans (no agentUserId) never enter this helper — callers must gate.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../client-pg.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { openRunSession } from "./open-run-session.js";
import { getRequestClientKey } from "./request-write-context.js";

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
}

/**
 * The session bound to THIS client, or null. A session the client STARTED
 * (start_session stamps `metadata.clientKey`) wins over one this door
 * auto-opened for it; an auto-opened one only counts while it is inside its
 * activity window. `onlyAutoOpened` narrows to the latter (start_session's
 * adoption lookup).
 */
export async function findClientSession(
  userId: string,
  clientKey: string,
  opts: { onlyAutoOpened?: boolean; database?: Pick<typeof db, "select"> } = {}
): Promise<ClientSession | null> {
  const database = opts.database ?? db;
  const autoOpened = sql`coalesce((${focusSessions.metadata} ->> 'autoOpened')::boolean, false)`;
  const rows = await database
    .select({ id: focusSessions.id, autoOpened: sql<boolean>`${autoOpened}` })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.userId, userId),
        inArray(focusSessions.status, [...CLIENT_SESSION_STATUSES]),
        sql`${focusSessions.metadata} ->> 'clientKey' = ${clientKey}`,
        opts.onlyAutoOpened ? sql`${autoOpened}` : undefined,
        // An auto-opened session is the client's CURRENT one only while it saw
        // activity inside the window; one it started itself stays bound until
        // it is closed.
        sql`(NOT ${autoOpened} OR greatest(${focusSessions.updatedAt}, coalesce((select max(p.created_at) from proposals p where p.session_id = ${focusSessions.id}), ${focusSessions.updatedAt})) > now() - (${RECEIPT_IDLE_WINDOW_HOURS}::int * interval '1 hour'))`
      )
    )
    .orderBy(sql`${autoOpened} asc`, desc(focusSessions.startedAt))
    .limit(1);
  const row = rows[0];
  return row ? { id: row.id, autoOpened: row.autoOpened === true } : null;
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

    // 2) The client's own session.
    const bound = await findClientSession(input.userId, clientKey);
    if (bound) return bound.id;

    // 3) Auto-open, serialized per client: the lock is held until this
    // transaction ends, so a concurrent resolver for the same client waits,
    // then re-reads (READ COMMITTED sees the row the winner committed) and
    // reuses it instead of opening a second one.
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`receipt|${input.userId}|${clientKey}`}))`
      );
      const raced = await findClientSession(input.userId, clientKey, {
        database: tx,
      });
      if (raced) return raced.id;
      // Inserted on the tx: the lock and the insert share one connection.
      const opened = await openRunSession({
        database: tx as unknown as typeof db,
        userId: input.userId,
        agentUserId: input.agentUserId,
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        goal,
        title: input.title ?? null,
        source: "agent-write",
        extraMetadata: {
          kind: AGENT_PROPOSAL_PACKAGE_MARKER,
          autoOpened: true,
          clientKey,
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
