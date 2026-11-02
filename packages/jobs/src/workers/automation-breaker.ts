/**
 * The never-worked breaker — an automation that has NEVER succeeded stops
 * itself after N failures instead of failing forever in silence.
 *
 * WHY: `New Contact Enrichment` ran 541 times with 0 successes (267 in a single
 * day) on the founder's pod and nobody found out for days. Every failure was
 * recorded correctly; nothing ever concluded anything from the record.
 *
 * WHAT IT WRITES: `automations.status = 'error'` + a human `errorMessage`.
 * Deliberately `error`, NOT `paused`:
 *   • `paused` means "a human deliberately turned it off" — writing it here
 *     would file a system verdict under a human's name, and `paused` has no
 *     notifier, so the user would still never be told.
 *   • `error` is the state the SHIPPED alerting half already reads:
 *     `scanBrokenAutomations` (@synap/api) fans an `automation.broken`
 *     notification out to the workspace members, deduped on a 24h cooldown,
 *     with a "view" action. That consumer had ZERO producers until this file —
 *     nothing in the pod ever wrote `status='error'` — which is exactly why 541
 *     failures were invisible.
 *   • Both statuses stop it firing (`automation-trigger-matcher` and
 *     `automation-cron-scheduler` both require `status='active'`), and `error`
 *     is in the user-facing create/update enum, so re-enabling is the ordinary
 *     "set it back to Active" edit — no admin door needed.
 *
 * A silent disable is its own defect (Zapier's prior art: auto-disable AND mail
 * the owner). The disable is written here; the telling is the existing
 * `automation.broken` notification, so this stays one mechanism, not a second
 * private channel.
 */
import {
  db,
  eq,
  and,
  desc,
  inArray,
  automations,
  automationRuns,
  drizzleSql,
} from "@synap/database";
import { GOAL_WORKER_FAILURE_LIMIT } from "@synap-core/types/workers/health";
import { logger } from "./automation-executor-logger.js";
import { runFilingOfFlow } from "../utils/run-filing.js";

/**
 * How many failures with ZERO successes before the automation turns itself off.
 *
 * 10, and the number is doing real work in both directions:
 *   • LOW ENOUGH to matter — the incident's automation fired ~267×/day, so 10
 *     caps a never-working flow at roughly one hour of noise instead of 541
 *     runs over weeks.
 *   • HIGH ENOUGH to survive a blip — a run only fails after the executor's own
 *     per-step retries are exhausted, so 10 run-level failures is already far
 *     past a transient IS restart or a network wobble.
 *
 * There is no TIME window on purpose. The `successCount === 0` floor is the
 * window: this can only ever trip on an automation that has never worked once —
 * a broken-on-arrival configuration, which is the entire class this incident is
 * in. A time window would instead let a slow-but-permanently-broken flow (one
 * failure an hour, forever) evade the breaker, which is the same invisibility
 * defect wearing a different hat.
 *
 * The OTHER half — an automation that succeeded once and then broke forever —
 * is {@link tripBrokeAfterWorkingBreaker} below: `successCount` is a lifetime
 * counter, so "consecutive failures since the last success" is read off the
 * run ledger instead (a bounded per-failure scan, no new column).
 */
export const NEVER_WORKED_FAILURE_LIMIT = 10;

/** Keep the stored sentence readable in a notification body / a table cell. */
const REASON_MAX = 400;

export interface BreakerCounters {
  status: string;
  successCount: number;
  failureCount: number;
}

/**
 * Pure predicate — kept separate from the write so it is testable without a DB.
 * Only an ACTIVE automation trips: a draft/paused/error/archived row is either
 * already off or already flagged, and re-writing it would re-arm the notifier's
 * cooldown on a row nobody re-enabled.
 */
export function shouldTripNeverWorkedBreaker(c: BreakerCounters): boolean {
  return (
    c.status === "active" &&
    c.successCount === 0 &&
    c.failureCount >= NEVER_WORKED_FAILURE_LIMIT
  );
}

/**
 * THE breaker sentence — in the runs ledger AND as the notification body. One
 * shape for both causes: what happened, the last failure, what to do. The
 * object is a RULE and the verb is Resume, the words the Rules page uses.
 */
function turnedOffMessage(lead: string, reason: string | null): string {
  const cause = reason?.trim()
    ? ` Last failure: ${reason.trim().slice(0, REASON_MAX)}`
    : "";
  return `Turned off automatically after ${lead}.${cause} Fix it, then resume the rule.`;
}

/** The sentence the user reads when a rule that never worked is turned off. */
export function breakerErrorMessage(
  failureCount: number,
  reason: string | null
): string {
  return turnedOffMessage(
    `${failureCount} failed runs and no successes`,
    reason
  );
}

/**
 * Trip the breaker if the counters say this automation has never worked.
 * `failureCount` counts budget stops too (`automation_runs.stop_reason =
 * 'budget'`, founder F3): they are subtracted, read off the ledger only once
 * the raw counters would trip, so a rule whose runs only ever stop at their
 * budget is never turned off by it. Non-throwing: a breaker write must never
 * turn a recorded failure into a crashed job.
 */
export async function tripNeverWorkedBreaker(input: {
  automationId: string;
  status: string;
  successCount: number;
  failureCount: number;
  reason: string | null;
}): Promise<boolean> {
  if (!shouldTripNeverWorkedBreaker(input)) return false;

  try {
    const [budget] = await db
      .select({ stops: drizzleSql<number>`count(*)::int` })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, input.automationId),
          eq(automationRuns.status, "failed"),
          eq(automationRuns.stopReason, "budget")
        )
      );
    const failureCount = input.failureCount - (budget?.stops ?? 0);
    if (!shouldTripNeverWorkedBreaker({ ...input, failureCount })) return false;

    const flipped = await db
      .update(automations)
      .set({
        status: "error",
        errorMessage: breakerErrorMessage(failureCount, input.reason),
        updatedAt: new Date(),
      })
      // Re-assert both floors in the WHERE so a concurrent human edit (pause,
      // archive, or a fix that produced a success) wins over this write.
      .where(
        and(
          eq(automations.id, input.automationId),
          eq(automations.status, "active"),
          drizzleSql`COALESCE(${automations.successCount}, 0) = 0`
        )
      )
      .returning({ id: automations.id });

    if (flipped.length === 0) return false;

    logger.error(
      {
        automationId: input.automationId,
        failureCount,
        limit: NEVER_WORKED_FAILURE_LIMIT,
      },
      "Automation turned off by the never-worked breaker (0 successes)"
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, automationId: input.automationId },
      "never-worked breaker write failed — automation left active"
    );
    return false;
  }
}

// ── The worked-then-broke breaker ───────────────────────────────────────────

/**
 * How many SETTLED runs in a row must fail before a rule that HAS worked turns
 * itself off. Same number as the never-worked limit, for the same reasons (a
 * run only fails after its per-step retries are spent, so 10 is far past a
 * blip), and so one sentence describes both breakers.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 10;

/**
 * The statuses that SETTLE a run's verdict for this breaker. `skipped` (dedup,
 * daily cap, precondition) and `blocked_by_policy` (governance said no —
 * nothing broke) neither break nor heal the streak; `cancelled` is a person's
 * act. Only a real success resets it and only a real failure extends it: a
 * `failed` run with `stop_reason = 'budget'` (its children only stopped at
 * their budget, founder F3) is left out of the streak too.
 */
export const STREAK_STATUSES = ["completed", "failed"] as const;

/**
 * Pure predicate. Trips only an ACTIVE rule that has succeeded at least once
 * (the never-worked breaker owns `successCount === 0`) and whose newest
 * {@link CONSECUTIVE_FAILURE_LIMIT} settled runs — newest first — all failed.
 * Fewer settled runs than the limit never trips: "not enough evidence" is not
 * "broken".
 */
export function shouldTripBrokeAfterWorking(input: {
  status: string;
  successCount: number;
  /** Settled statuses ({@link STREAK_STATUSES}), newest first. */
  recentSettled: readonly string[];
}): boolean {
  if (input.status !== "active" || input.successCount === 0) return false;
  const window = input.recentSettled.slice(0, CONSECUTIVE_FAILURE_LIMIT);
  return (
    window.length >= CONSECUTIVE_FAILURE_LIMIT &&
    window.every((s) => s === "failed")
  );
}

/** The sentence the user reads when a rule that used to work is turned off. */
export function brokeAfterWorkingMessage(reason: string | null): string {
  return turnedOffMessage(
    `${CONSECUTIVE_FAILURE_LIMIT} failed runs in a row (it had worked before)`,
    reason
  );
}

/**
 * Trip the breaker on a rule that worked and then broke. Writes the same
 * `status = 'error'` + `errorMessage` as the never-worked breaker, so the SAME
 * `automation.broken` notification tells the owner — one mechanism, two
 * causes. Reads at most {@link CONSECUTIVE_FAILURE_LIMIT} ledger rows, and
 * only after a failure on a rule that has a success on record. Non-throwing.
 */
export async function tripBrokeAfterWorkingBreaker(input: {
  automationId: string;
  status: string;
  successCount: number;
  reason: string | null;
}): Promise<boolean> {
  if (input.status !== "active" || input.successCount === 0) return false;
  try {
    const recent = await db
      .select({ status: automationRuns.status })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, input.automationId),
          inArray(automationRuns.status, [...STREAK_STATUSES]),
          drizzleSql`${automationRuns.stopReason} IS DISTINCT FROM 'budget'`
        )
      )
      .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
      .limit(CONSECUTIVE_FAILURE_LIMIT);
    if (
      !shouldTripBrokeAfterWorking({
        status: input.status,
        successCount: input.successCount,
        recentSettled: recent.map((r) => r.status),
      })
    ) {
      return false;
    }
    const flipped = await db
      .update(automations)
      .set({
        status: "error",
        errorMessage: brokeAfterWorkingMessage(input.reason),
        updatedAt: new Date(),
      })
      // A concurrent human edit (pause, archive) wins over this write.
      .where(
        and(
          eq(automations.id, input.automationId),
          eq(automations.status, "active")
        )
      )
      .returning({ id: automations.id });
    if (flipped.length === 0) return false;
    logger.error(
      {
        automationId: input.automationId,
        limit: CONSECUTIVE_FAILURE_LIMIT,
      },
      "Automation turned off by the worked-then-broke breaker (consecutive failures)"
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, automationId: input.automationId },
      "worked-then-broke breaker read/write failed — automation left active"
    );
    return false;
  }
}

// ── The goal worker breaker (goals that run, decision 7) ────────────────────

/**
 * Pure predicate. A worker that runs for a GOAL (its `playbook_run` node is
 * filed in one, `runFilingOfFlow`) is turned off after
 * {@link GOAL_WORKER_FAILURE_LIMIT} settled runs in a row failed — sooner
 * than any other rule ({@link CONSECUTIVE_FAILURE_LIMIT}), whether or not it
 * ever worked: a goal runs on its own, and three failures nobody sees is the
 * silence the goal exists to end. The streak is the worked-then-broke
 * breaker's ({@link STREAK_STATUSES}, budget stops left out); fewer settled
 * runs than the limit never trips.
 */
export function shouldTripGoalWorker(input: {
  status: string;
  /** Settled statuses ({@link STREAK_STATUSES}), newest first. */
  recentSettled: readonly string[];
}): boolean {
  if (input.status !== "active") return false;
  const window = input.recentSettled.slice(0, GOAL_WORKER_FAILURE_LIMIT);
  return (
    window.length >= GOAL_WORKER_FAILURE_LIMIT &&
    window.every((s) => s === "failed")
  );
}

/** The sentence the user reads when a goal's worker is turned off. */
export function goalWorkerOffMessage(reason: string | null): string {
  return turnedOffMessage(
    `${GOAL_WORKER_FAILURE_LIMIT} failed runs in a row (it runs for a goal)`,
    reason
  );
}

/**
 * Trip the goal worker breaker: same `status = 'error'` + sentence as the
 * other two (one mechanism, one `automation.broken` notification), read only
 * after a failure. Reads the automation's flow (is it a goal's worker?) and at
 * most {@link GOAL_WORKER_FAILURE_LIMIT} ledger rows. Non-throwing.
 */
export async function tripGoalWorkerBreaker(input: {
  automationId: string;
  status: string;
  reason: string | null;
}): Promise<boolean> {
  if (input.status !== "active") return false;
  try {
    const [row] = await db
      .select({ flow: automations.flowDefinition })
      .from(automations)
      .where(eq(automations.id, input.automationId))
      .limit(1);
    const flow = row?.flow as
      { nodes?: Array<{ type?: string; data?: unknown }> } | null | undefined;
    if (!runFilingOfFlow({ nodes: flow?.nodes ?? [] }).trackId) return false;
    const recent = await db
      .select({ status: automationRuns.status })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, input.automationId),
          inArray(automationRuns.status, [...STREAK_STATUSES]),
          drizzleSql`${automationRuns.stopReason} IS DISTINCT FROM 'budget'`
        )
      )
      .orderBy(desc(automationRuns.startedAt), desc(automationRuns.id))
      .limit(GOAL_WORKER_FAILURE_LIMIT);
    if (
      !shouldTripGoalWorker({
        status: input.status,
        recentSettled: recent.map((r) => r.status),
      })
    ) {
      return false;
    }
    const flipped = await db
      .update(automations)
      .set({
        status: "error",
        errorMessage: goalWorkerOffMessage(input.reason),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(automations.id, input.automationId),
          eq(automations.status, "active")
        )
      )
      .returning({ id: automations.id });
    if (flipped.length === 0) return false;
    logger.error(
      { automationId: input.automationId, limit: GOAL_WORKER_FAILURE_LIMIT },
      "Automation turned off by the goal worker breaker (consecutive failures)"
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, automationId: input.automationId },
      "goal worker breaker read/write failed — automation left active"
    );
    return false;
  }
}
