/**
 * Automation Run Reaper
 *
 * Failsafe for the ONE reliability defect in the automation pipeline: an
 * `automation_runs` row is written `status:'running'` BEFORE the job is enqueued,
 * and the happy-path completed/failed writes live only inside the executor. Any
 * setup-window throw (cycle check, session open) or worker death (redeploy
 * SIGTERM / OOM) between those two points orphans the row as "running" forever
 * with zero step rows. This cron finalizes such stale rows and closes the
 * orphaned focus session each one opened.
 *
 * The ONE legitimate long-"running" case is a delay-node suspended run: it
 * re-enqueues itself with `startAfter` and stays "running" across the delay. Such
 * a run ALWAYS has step rows, and its most-recent step carries
 * `output->>'status' = 'delayed'` (the DB `status` column is 'completed' — there
 * is no 'delayed' step status). We EXEMPT those via `RUN_NOT_DELAY_SUSPENDED`.
 * Runs with NO steps are the orphans we came for — never exempt.
 */

import {
  db,
  and,
  eq,
  drizzleSql,
  automationRuns,
  focusSessions,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { postRunSummary } from "../utils/post-run-summary.js";

const logger = createLogger({ module: "automation-run-reaper" });

export const AUTOMATION_RUN_REAPER_QUEUE = "automation-run-reaper";
export const AUTOMATION_RUN_REAPER_CRON = "*/5 * * * *";

/** A run "running" longer than this with no legit reason is presumed orphaned. */
export const REAPER_STALE_MINUTES = 45;

const STALE_RUN_ERROR_MESSAGE =
  "Timed out: the run never finalized (worker died or hung). Auto-failed by the run reaper.";

/**
 * A run is delay-suspended (and must NOT be reaped/force-failed) iff its
 * most-recently-started step row is a delay step — `output->>'status' = 'delayed'`
 * with no later-started step. Referencing `automation_runs.id` correlates this to
 * the UPDATE target, so both the reaper and the executor's defensive finalizer
 * (both UPDATE `automation_runs`) share this ONE predicate. Empty-steps runs make
 * the inner EXISTS false → NOT EXISTS true → NOT exempt (correctly reaped).
 */
export const RUN_NOT_DELAY_SUSPENDED = drizzleSql`NOT EXISTS (
  SELECT 1 FROM automation_step_runs s
  WHERE s.run_id = ${automationRuns.id}
    AND s.output->>'status' = 'delayed'
    AND NOT EXISTS (
      SELECT 1 FROM automation_step_runs later
      WHERE later.run_id = ${automationRuns.id}
        AND later.started_at > s.started_at
    )
)`;

/** Called by the cron scheduler every ~5 minutes. */
export async function handleAutomationRunReaper(): Promise<void> {
  try {
    // 1. Finalize stale running runs that are not delay-suspended. The cutoff is
    //    computed in SQL (int * interval) so no Date param is bound — postgres.js
    //    3.4.8 crashes on Date/object Bind params on the pod image.
    const reaped = await db
      .update(automationRuns)
      .set({
        status: "failed",
        errorMessage: STALE_RUN_ERROR_MESSAGE,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(automationRuns.status, "running"),
          drizzleSql`${automationRuns.startedAt} < now() - (${REAPER_STALE_MINUTES}::int * interval '1 minute')`,
          RUN_NOT_DELAY_SUSPENDED
        )
      )
      .returning({ id: automationRuns.id });

    if (reaped.length === 0) {
      logger.debug("No stale automation runs to reap");
      return;
    }

    // 2. Close each reaped run's orphaned active focus session — mirror the
    //    executor's closeSessionIfOwned door (status='closed', closedAt=now()).
    //    Keyed on metadata.automationRunId (where openRunSession stamps it). A
    //    per-run UPDATE (like vault-grant-expiry) keeps a single bound string
    //    param and avoids array-param typing on the pod driver.
    let sessionsClosed = 0;
    for (const { id } of reaped) {
      const closed = await db
        .update(focusSessions)
        .set({ status: "closed", closedAt: new Date() })
        .where(
          and(
            eq(focusSessions.status, "active"),
            drizzleSql`${focusSessions.metadata}->>'automationRunId' = ${id}`
          )
        )
        .returning({ id: focusSessions.id });
      sessionsClosed += closed.length;

      // 3. Narrate the timed-out run into its channel (idempotent, non-throwing
      //    — Wave 3.N1). `reason: "timeout"` forces the timeout copy/class even
      //    though the row now reads `failed`. Respects narrationMode `off`;
      //    `failures`/`changes` post it (a timeout is a failure). The internal
      //    claim guarantees no double-post if the executor also finalized.
      await postRunSummary(id, { reason: "timeout" });
    }

    logger.info(
      { reaped: reaped.length, sessionsClosed },
      "Automation run reaper swept stale runs"
    );
  } catch (err) {
    logger.error({ err }, "Automation run reaper failed");
    throw err; // Let pg-boss handle retry.
  }
}
