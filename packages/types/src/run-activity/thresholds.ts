/**
 * The two health boundaries every run surface shares — the pod's run groupers
 * and `diagnose`, and any client that re-derives a group fact — so "failing"
 * and "stuck" mean the same thing on the server and in the console.
 */

/**
 * Days a failure counts as CURRENT for health: a flow is "failing" when it
 * has a failed run in this window, never on lifetime runs (lifetime stays on
 * `failedCount` for the drill-down).
 *
 * A run's instant is `completedAt ?? startedAt` — the server measures
 * `coalesce(completed_at, started_at)` in SQL, so a run that started before
 * the window but failed inside it is recent.
 */
export const RECENT_FAILURE_WINDOW_DAYS = 7;

/** Hours a run may stay `running` before it is "stuck". */
export const DEFAULT_STUCK_THRESHOLD_HOURS = 24;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * THE recent-failure rule in TypeScript — the twin of the SQL in the run
 * groupers. `failed` runs only are passed in: a `blocked_by_policy` run is a
 * calm governance outcome and never makes a flow "failing".
 */
export function isRecentFailure(
  run: { completedAt?: Date | string | null; startedAt: Date | string },
  nowMs: number
): boolean {
  const at = new Date(run.completedAt ?? run.startedAt).getTime();
  return at > nowMs - RECENT_FAILURE_WINDOW_DAYS * DAY_MS;
}
