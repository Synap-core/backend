/**
 * LIVE run statuses — the ONE answer to "is this playbook/automation run still
 * going?" (W2 calm review, 2026-09-28).
 *
 * `waiting_on_you` is a run the reaper found past its window while its session
 * still owed the person an open slot: not failed, not finished — paused on the
 * human. Every door that finishes, advances or reads the frozen definition of
 * a live run must match it too; a door matching `status = 'running'` alone
 * silently drops the final write and leaves the run parked forever.
 *
 * `stale` (playbook runs only, D6 2026-10-11) is a run an EXTERNAL agent holds
 * that the reaper found quiet: not finished, not failed, revived to `running`
 * by the next write attributed to its session. Live for the same reason as
 * `waiting_on_you` — a late capture-back, `complete_session`, a cancel or a
 * provider poll must still land on it.
 *
 * `running`-only stays correct for exactly two readers, by design: the stale
 * sweeps (a waiting run is not "stale", it is waiting) and "in flight now"
 * counters (`hasRunning` / `runningCount`).
 */

import { inArray, notInArray, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const LIVE_RUN_STATUSES = [
  "running",
  "waiting_on_you",
  "stale",
] as const;
export type LiveRunStatus = (typeof LIVE_RUN_STATUSES)[number];

export function isLiveRunStatus(status: unknown): status is LiveRunStatus {
  return (LIVE_RUN_STATUSES as readonly unknown[]).includes(status);
}

/** SQL: the run's status column is live. */
export function liveRunStatusWhere(statusColumn: AnyPgColumn): SQL {
  return inArray(statusColumn, [...LIVE_RUN_STATUSES]);
}

/** SQL: the run has reached a verdict (anything not live). */
export function settledRunStatusWhere(statusColumn: AnyPgColumn): SQL {
  return notInArray(statusColumn, [...LIVE_RUN_STATUSES]);
}
