/**
 * THE WORK CLOCK LADDER — how long since work last moved, in four rungs.
 *
 * Before this module the pod and its surfaces kept about 14 separate
 * "quiet / stale / stuck" clocks (lane E inventory, 2026-10-30, §1.4), each a
 * literal of its own: a session read "working" on one rule, "gone quiet" on a
 * second, and the reaper's `stale` meant one thing on the pod and another on
 * the phone. Each clock that is one of these rungs now COMPOSES it, never
 * copies it, so moving a rung moves every reader at once.
 *
 *   live   5 min   an agent is working right now: a turn in flight, or
 *                  activity inside this window (founder decision D1,
 *                  `isSessionWorkingNow`, `../run-activity/live.ts`).
 *   quiet  30 min  open, and nothing recorded for this long: the session has
 *                  GONE QUIET (decision 12, `SESSION_GONE_QUIET_MS`).
 *   stale  24 h    untouched this long, work is presumed abandoned: the
 *                  session reaper stamps `stale` and the run reapers fail an
 *                  orphaned run. A `stale` session READS AS PAUSED (category
 *                  `paused`, `SESSION_STATUS_DECLARATION`,
 *                  `isSuspendedSessionStatus`): the reaper measured a silence,
 *                  so it is never "unmeasured" and never "working".
 *   stuck  7 days  waiting this long is stuck: needs-you files it Stopped, a
 *                  next move turns red, a loose end is listed, an agent's
 *                  last call reads old, a pending proposal goes to Review
 *                  later.
 *
 * A rung is a THRESHOLD: a thing reaches it once its age is at least the
 * rung's value (each reader keeps its own comparison).
 *
 * Clocks of this family whose value is NOT a rung keep it until someone
 * decides (open decisions, 2026-10-30): the automation-run reaper's 45 min
 * (and `diagnose`'s stall, which borrows it), an external agent's 60 min
 * quiet, a puller's 15 min live window, a chat turn's 2 h, a track report's
 * 48 h escalation, an agent session's 14-day abandonment, a hold's 14-day
 * review, the 30-day hygiene clocks. `api/__tripwires__/work-clock-one-ladder`
 * fails when a clock of the family repeats a rung as a literal.
 *
 * Pure and dependency-free: Relay, the browser, the CLI and the pod import it.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The rungs, youngest first. */
export const WORK_CLOCK_RUNGS = ["live", "quiet", "stale", "stuck"] as const;
export type WorkClockRung = (typeof WORK_CLOCK_RUNGS)[number];

/** Each rung's threshold in milliseconds. */
export const WORK_CLOCK: Readonly<Record<WorkClockRung, number>> = {
  live: 5 * MINUTE_MS,
  quiet: 30 * MINUTE_MS,
  stale: 24 * HOUR_MS,
  stuck: 7 * DAY_MS,
};

/** A rung in the unit a reader stores (hours, days, minutes). */
export function workClockIn(
  rung: WorkClockRung,
  unit: "minutes" | "hours" | "days"
): number {
  const per =
    unit === "minutes" ? MINUTE_MS : unit === "hours" ? HOUR_MS : DAY_MS;
  return WORK_CLOCK[rung] / per;
}
