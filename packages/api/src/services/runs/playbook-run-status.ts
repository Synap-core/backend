/**
 * A ledger's stored status → the unified run vocabulary (`RunStatus`), READ
 * OFF THE MACHINE'S DECLARATION, never a hand map per ledger. One rule for
 * every declared ledger (playbook runs, sessions):
 *
 *   a stored word the feed speaks itself stays as it is (`running`,
 *   `proposed`, `waiting_on_you`, `failed`, `cancelled`, `paused`);
 *   any other word reads as its CATEGORY's word ({@link CATEGORY_RUN_STATUS}):
 *   `closed` (done) → completed, `active` → running, `stale` (paused) →
 *   paused — the reaper's `stale` reads as paused everywhere (founder,
 *   2026-11-20), never `cancelled` (nothing ended) and never `running`
 *   (nothing is moving).
 *
 * The status FILTER is the same rule run backwards: the stored words whose
 * reading is the asked status, so a row's badge and the filter that finds it
 * can never disagree.
 *
 * A run is born `queued` and the feed says so; a `forming` SESSION (a planned
 * step: category `open`, not started) reads `queued` too (P1). Automation runs and chat turns
 * have no declaration yet (W2) and keep their own mappers in `./index.ts`.
 */
import {
  SESSION_STATUSES,
  sessionStatusCategory,
} from "@synap-core/types/focus-sessions";
import type { LifecycleCategory } from "@synap-core/types/lifecycle";
import {
  PLAYBOOK_RUN_STATUSES,
  runStatusCategory,
} from "@synap-core/types/units";
import { isRunStatus, type RunStatus } from "./types.js";

/** The feed word of each category, for a stored word the feed does not speak. */
const CATEGORY_RUN_STATUS = {
  // Not started (a planned step): it waits its turn, like a queued run.
  open: "running",
  active: "running",
  paused: "paused",
  done: "completed",
  lost: "cancelled",
} as const satisfies Record<LifecycleCategory, RunStatus>;

function readAs(status: string, category: LifecycleCategory | null): RunStatus {
  if (isRunStatus(status)) return status;
  // A value no declaration knows is a stored word this build cannot read;
  // the column enums make it unreachable. It reads as still going, as the
  // feed always read it.
  return category ? CATEGORY_RUN_STATUS[category] : "running";
}

/** A `playbook_runs.status` → `RunStatus`, by the run declaration. */
export function runStatusOfPlaybookRun(status: string): RunStatus {
  return readAs(status, runStatusCategory(status));
}

/** A `focus_sessions.status` → `RunStatus`, by the session declaration. */
export function runStatusOfSession(status: string): RunStatus {
  return readAs(status, sessionStatusCategory(status));
}

/** The stored playbook-run statuses that read as `status` (the filter). */
export function playbookRunStatusesReadingAs(status: RunStatus) {
  return PLAYBOOK_RUN_STATUSES.filter(
    (s) => runStatusOfPlaybookRun(s) === status
  );
}

/**
 * The stored session statuses that read as `status` (the filter). Never
 * `scheduled`: an appointment has executed nothing, so it is not a run at all
 * (`listSessionRuns` excludes it at the query).
 */
export function sessionStatusesReadingAs(status: RunStatus) {
  return SESSION_STATUSES.filter(
    (s) => s !== "scheduled" && runStatusOfSession(s) === status
  );
}
