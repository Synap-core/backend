/**
 * THE WAKE (founder decision P3, 21 Nov 2026) — a PLANNED step (`forming`)
 * starts by itself when what it waits on is over: every blocker DELIVERED
 * (THE dependency rule, `readDependencyState`), no output it waits on still
 * being produced, and its `plannedFor` window open. One rule decides:
 * `isStepReadyToWake` (`@synap-core/types/units`), the readiness rule the
 * canvas reads too.
 *
 * WHEN — only from seams that already exist, never a scheduler of its own:
 *   · the unblock reactor (`session-unblock-reactor.ts`), the moment a
 *     dependent's LAST blocker delivers: a session closed delivered, a
 *     decision accepted, a goal closed;
 *   · the hourly session lifecycle sweep (`session-lifecycle-sweep.ts`, on
 *     the focus-session reaper's tick): the safety net, and the only waker of
 *     a step whose DATE comes (nothing else moves then).
 *
 * WHAT — a WAKE ONLY: `forming → active` through THE session status write
 * (`setSessionStatus`) with a compare-and-set from `forming` (a step someone
 * started, cancelled or re-planned meanwhile is left as it is), as the
 * system, with ONE audit line (the transition's reason). It stamps
 * `startedAt` (the session status write does, for any start of a planned
 * step). It starts NO agent and dispatches nothing: the step reads ready
 * (active, its asks now owed) and whoever holds it picks it up — a
 * playbook-bound step follows its playbook's own start, which today is the
 * same (a session start dispatches nothing; `run-playbook.ts` does).
 *
 * GUARDS — a dropped blocker (cancelled, failed, closed with required work
 * open) never wakes: the step stays planned and reads `blocked` until its
 * owner re-plans. A blocker the pod cannot read holds (never "ready" on a
 * guess). Cycles are refused when an edge is written (`closesDependencyCycle`)
 * and `deriveOpenBlockers` is cycle-safe on `replaces`; a wake closes
 * nothing, so it cannot cascade into another wake. The sweep leaves a step
 * born in the last {@link PLANNED_WAKE_SETTLE_MINUTES} minutes to its birth
 * door: a start or a plan writes its blockers just AFTER the row.
 */
import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  asc,
  eq,
  drizzleSql,
  focusSessions,
  setSessionStatus,
} from "@synap/database";
import {
  PLANNED_SESSION_STATUS,
  isPlannedSessionStatus,
} from "@synap-core/types/focus-sessions";
import { isStepReadyToWake, stepTimeOf } from "@synap-core/types/units";
import { readDependencyState } from "../links/dependency-links.js";
import { openOutputBlockerIds } from "./session-output-edges.js";

const logger = createLogger({ module: "planned-wake" });

/** A step this young is left to its birth door (blockers land after the row). */
export const PLANNED_WAKE_SETTLE_MINUTES = 10;
/** Most planned steps the sweep reads per tick (each runs the full rule). */
export const PLANNED_WAKE_SWEEP_LIMIT = 200;

export type PlannedWakeOutcome =
  /** Moved `forming → active` now. */
  | "woken"
  /** Not a planned step (any more): nothing to do. */
  | "not_planned"
  /** Still waits: a blocker, an output, or its date. */
  | "not_ready"
  /** It moved between the read and the write (the compare-and-set held). */
  | "moved";

/**
 * Wake ONE planned step when THE rule says it is ready. Never throws for a
 * step that is not ready; a failed read throws (the caller logs it).
 */
export async function wakePlannedSession(input: {
  sessionId: string;
  /** The audit line: why it starts now ("Its last blocker delivered."). */
  reason: string;
  now?: Date;
}): Promise<PlannedWakeOutcome> {
  const [row] = await db
    .select({
      id: focusSessions.id,
      status: focusSessions.status,
      userId: focusSessions.userId,
      metadata: focusSessions.metadata,
    })
    .from(focusSessions)
    .where(eq(focusSessions.id, input.sessionId))
    .limit(1);
  if (!row || !isPlannedSessionStatus(row.status)) return "not_planned";

  const now = input.now ?? new Date();
  const [state, outputs] = await Promise.all([
    readDependencyState({ kind: "session", id: row.id }, row.userId),
    openOutputBlockerIds(row.id, row.userId),
  ]);
  const ready = isStepReadyToWake({
    status: row.status,
    // An output still being produced holds like an open blocker.
    openBlockers: [
      ...state.openBlockers,
      ...outputs.map(() => ({ dropped: false })),
    ],
    plannedFor: stepTimeOf(row.metadata).plannedFor,
    now: now.getTime(),
  });
  if (!ready) return "not_ready";

  const { rows } = await setSessionStatus(db, {
    sessionId: row.id,
    from: PLANNED_SESSION_STATUS,
    to: "active",
    actor: { kind: "system", userId: row.userId },
    reason: input.reason,
    // Starting is activity: the idle clock starts here.
    set: { updatedAt: now },
  });
  return rows.length > 0 ? "woken" : "moved";
}

/**
 * The hourly safety net: every planned step past its settle window, oldest
 * touched first, through {@link wakePlannedSession}. Returns how many woke;
 * a step that fails is logged and the sweep goes on.
 */
export async function sweepPlannedSessions(
  now: Date = new Date()
): Promise<number> {
  const rows = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        eq(focusSessions.status, PLANNED_SESSION_STATUS),
        drizzleSql`${focusSessions.createdAt} < now() - (${PLANNED_WAKE_SETTLE_MINUTES}::int * interval '1 minute')`
      )
    )
    // SESSION-KIND-LENS-EXEMPT: the pod's own sweep over every planned step.
    .orderBy(asc(focusSessions.updatedAt))
    .limit(PLANNED_WAKE_SWEEP_LIMIT);
  let woken = 0;
  for (const { id } of rows) {
    try {
      const outcome = await wakePlannedSession({
        sessionId: id,
        reason: "Nothing holds it any more: it starts now.",
        now,
      });
      if (outcome === "woken") woken += 1;
    } catch (err) {
      logger.error({ err, sessionId: id }, "planned wake failed — next tick");
    }
  }
  return woken;
}
