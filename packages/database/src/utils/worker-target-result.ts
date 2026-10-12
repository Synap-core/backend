/**
 * WORKER TARGET RESULT — the ONE writer of what a stage worker did with each
 * thing it targets (work model L4/L5).
 *
 * The edge is `session --targets--> entity` with `links.metadata.role =
 * WORKER_TARGET_LINK_ROLE` (`worker-enablement.ts`, pinned equal to
 * `@synap-core/types/workers` `WORKER_TARGET_ROLE`). A target with no `result`
 * is still being worked; a result is a MARK (done / failed / skipped /
 * created), never an absence.
 *
 * FIRST VERDICT WINS. The stamp is one UPDATE guarded on `result IS NULL`, the
 * same rule as `backStampEventSession` (jobs `playbook-run.ts`): process-sync
 * (a person moved the thing), the session close (unfinished targets) and the
 * runner can all reach the same edge, and the first fact is the true one. A
 * later writer that loses gets `false`, never an overwrite.
 *
 * Callers: api (session close, the runner) and jobs (process-sync). It lives
 * here because both import this package and neither imports the other.
 *
 * `role: "input"` edges (`session-inputs.ts`) are a different population and
 * are never given a result — every statement below filters on the role.
 */

import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../client-pg.js";
import { focusSessions } from "../schema/focus-sessions.js";
import { links } from "../schema/links.js";
import {
  WORKER_IN_FLIGHT_SESSION_STATUSES,
  WORKER_TARGET_LINK_ROLE,
} from "./worker-enablement.js";

/**
 * The pod's copy of `@synap-core/types/workers` `WORKER_TARGET_RESULTS`
 * (types imports this package, so the pod cannot import it).
 */
export const WORKER_TARGET_LINK_RESULTS = [
  "done",
  "failed",
  "skipped",
  "created",
] as const;
export type WorkerTargetLinkResult =
  (typeof WORKER_TARGET_LINK_RESULTS)[number];

/** A worker target edge of `sessionId` (any target, or one). */
function workerTargetWhere(sessionId: string, entityId?: string): SQL {
  return and(
    eq(links.fromType, "session"),
    eq(links.fromId, sessionId),
    eq(links.toType, "entity"),
    eq(links.linkType, "targets"),
    entityId ? eq(links.toId, entityId) : undefined,
    sql`${links.metadata}->>'role' = ${WORKER_TARGET_LINK_ROLE}`
  ) as SQL;
}

/** The result keys merged into the edge's metadata; nulls are left out. */
function resultPatch(v: {
  result: WorkerTargetLinkResult;
  reason?: string | null;
  transitionEventId?: string | null;
  at?: Date;
}): SQL {
  return sql`jsonb_strip_nulls(jsonb_build_object(
    'result', ${v.result}::text,
    'reason', ${v.reason ?? null}::text,
    'at', ${(v.at ?? new Date()).toISOString()}::text,
    'transitionEventId', ${v.transitionEventId ?? null}::text
  ))`;
}

/**
 * Stamp ONE target's result. Returns `true` when this call set it, `false`
 * when the edge is not a worker target of the session or already had a
 * result (first verdict wins).
 */
export async function stampWorkerTargetResult(input: {
  sessionId: string;
  entityId: string;
  result: WorkerTargetLinkResult;
  reason?: string | null;
  transitionEventId?: string | null;
  at?: Date;
}): Promise<boolean> {
  const rows = await db
    .update(links)
    .set({ metadata: sql`${links.metadata} || ${resultPatch(input)}` })
    .where(
      and(
        workerTargetWhere(input.sessionId, input.entityId),
        sql`${links.metadata}->>'result' IS NULL`
      )
    )
    .returning({ id: links.id });
  return rows.length > 0;
}

/**
 * Stamp EVERY still-open target of a session at once — the session close
 * ("unfinished" is `skipped` + `session_closed`, a mark, never an absence).
 * Returns the entity ids it stamped.
 */
export async function stampOpenWorkerTargets(input: {
  sessionId: string;
  result: WorkerTargetLinkResult;
  reason?: string | null;
  at?: Date;
}): Promise<string[]> {
  const rows = await db
    .update(links)
    .set({ metadata: sql`${links.metadata} || ${resultPatch(input)}` })
    .where(
      and(
        workerTargetWhere(input.sessionId),
        sql`${links.metadata}->>'result' IS NULL`
      )
    )
    .returning({ entityId: links.toId });
  return rows.map((r) => r.entityId);
}

/**
 * In-flight sessions still working `entityId` as a worker target (no result
 * yet). The process-sync side: a move of the thing settles these targets.
 */
export async function listOpenWorkerTargetSessions(entityId: string): Promise<
  Array<{
    sessionId: string;
    channelId: string | null;
    userId: string;
  }>
> {
  const rows = await db
    .select({
      sessionId: focusSessions.id,
      channelId: focusSessions.channelId,
      userId: focusSessions.userId,
    })
    .from(links)
    .innerJoin(focusSessions, eq(sql`${focusSessions.id}::text`, links.fromId))
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.toType, "entity"),
        eq(links.toId, entityId),
        eq(links.linkType, "targets"),
        sql`${links.metadata}->>'role' = ${WORKER_TARGET_LINK_ROLE}`,
        sql`${links.metadata}->>'result' IS NULL`,
        inArray(focusSessions.status, [...WORKER_IN_FLIGHT_SESSION_STATUSES])
      )
    );
  return rows;
}

/** One target of a session, as the session page reads it. */
export interface SessionWorkerTarget {
  entityId: string;
  /** Absent = still being worked. */
  result: WorkerTargetLinkResult | null;
  reason: string | null;
  at: string | null;
}

/** A session's worker targets with their results (the session page read). */
export async function listSessionWorkerTargets(
  sessionId: string
): Promise<SessionWorkerTarget[]> {
  const rows = await db
    .select({ entityId: links.toId, metadata: links.metadata })
    .from(links)
    .where(workerTargetWhere(sessionId));
  return rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const result = (WORKER_TARGET_LINK_RESULTS as readonly unknown[]).includes(
      m.result
    )
      ? (m.result as WorkerTargetLinkResult)
      : null;
    return {
      entityId: r.entityId,
      result,
      reason: typeof m.reason === "string" ? m.reason : null,
      at: typeof m.at === "string" ? m.at : null,
    };
  });
}
