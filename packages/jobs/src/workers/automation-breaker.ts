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
import { db, eq, and, automations, drizzleSql } from "@synap/database";
import { logger } from "./automation-executor-logger.js";

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
 * KNOWN, DELIBERATE GAP: an automation that succeeded once and then broke
 * forever is NOT caught — `successCount` is a lifetime counter, so "consecutive
 * failures since the last success" is not derivable from the columns that exist
 * today. Catching that case needs either a new `consecutive_failures` column or
 * a per-failure scan of `automation_runs`; it is deliberately not built here.
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

/** The sentence the user reads — in the runs ledger AND as the notification body. */
export function breakerErrorMessage(
  failureCount: number,
  reason: string | null
): string {
  const cause = reason?.trim()
    ? ` Last failure: ${reason.trim().slice(0, REASON_MAX)}`
    : "";
  return (
    `Turned off automatically after ${failureCount} failed runs and no successes.${cause}` +
    ` Fix the flow, then set this automation back to Active to resume it.`
  );
}

/**
 * Trip the breaker if the counters say this automation has never worked.
 * Non-throwing: a breaker write must never turn a recorded failure into a
 * crashed job.
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
    const flipped = await db
      .update(automations)
      .set({
        status: "error",
        errorMessage: breakerErrorMessage(input.failureCount, input.reason),
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
        failureCount: input.failureCount,
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
