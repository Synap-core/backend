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
  inArray,
  drizzleSql,
  automationRuns,
  focusSessions,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { postRunSummary } from "../utils/post-run-summary.js";
import { closeSessionViaDoor } from "../utils/session-close.js";

const logger = createLogger({ module: "automation-run-reaper" });

export const AUTOMATION_RUN_REAPER_QUEUE = "automation-run-reaper";
export const AUTOMATION_RUN_REAPER_CRON = "*/5 * * * *";

/** A run "running" longer than this with no legit reason is presumed orphaned. */
export const REAPER_STALE_MINUTES = 45;

/**
 * How long PAST a delay step's own `resumeAfter` we keep exempting the run.
 *
 * The delay exemption used to be UNBOUNDED, which turned it into a permanent
 * leak once `automation-execute` went `retryLimit: 0` (2026-07-31, see
 * `workers/index.ts` LONG_WALK_QUEUES): a worker death between the re-enqueue
 * and the resumed walk's FIRST new step row means pg-boss never redelivers, the
 * delay step is still the latest-started step, so the run stayed exempt — and
 * therefore `running` — forever. Focus session never closed, `automation_claims`
 * never released. The comment in index.ts claiming the cost is "up to ~50
 * minutes until the reaper sweeps" was false for exactly this class.
 *
 * Bounding it by the step's OWN recorded resume time (rather than by the run's
 * age) is what keeps a legitimately long delay — a 7-day wait — untouched: the
 * clock only starts when the run was SUPPOSED to wake up. The grace equals the
 * ordinary stale window, so a resumed walk gets the same slack as any other.
 */
export const REAPER_DELAY_GRACE_MINUTES = REAPER_STALE_MINUTES;

const STALE_RUN_ERROR_MESSAGE =
  "Timed out: the run never finalized (worker died or hung). Auto-failed by the run reaper.";

/**
 * A run is delay-suspended (and must NOT be reaped/force-failed) iff its
 * most-recently-started step row is a delay step — `output->>'status' = 'delayed'`
 * with no later-started step — AND that step's own `resumeAfter` has not been
 * past for longer than REAPER_DELAY_GRACE_MINUTES. Referencing
 * `automation_runs.id` correlates this to the UPDATE target, so both the reaper
 * and the executor's defensive finalizer (both UPDATE `automation_runs`) share
 * this ONE predicate. Empty-steps runs make the inner EXISTS false → NOT EXISTS
 * true → NOT exempt (correctly reaped).
 *
 * The `resumeAfter` bound is what stops the exemption from being a permanent
 * leak (see REAPER_DELAY_GRACE_MINUTES). The delay node writes it as an ISO
 * string alongside the marker (`automation-executor.ts`, case "delay"), so the
 * target time is always recoverable from the step row itself.
 *
 * THE SECOND CONSUMER — the executor's defensive finalizer ANDs this into its
 * catch-path UPDATE. Narrowing the exemption only ever lets that write land in a
 * case where it previously did nothing, and it only runs when the flow actually
 * THREW; a run that threw after its delay window elapsed SHOULD be recorded
 * `failed` rather than left `running`. So the narrowing is strictly corrective
 * there, never a false finalize: inside the delay window (and its grace) the
 * exemption is unchanged.
 *
 * CASE, not a bare AND, for the cast: `::timestamptz` THROWS on a malformed
 * string and Postgres does not guarantee AND-operand evaluation order, so a
 * regex guard as a sibling conjunct would not reliably run first. CASE does
 * guarantee ordered evaluation. The ELSE branch keeps the historical unbounded
 * exemption for a row whose `resumeAfter` is absent or unparseable — the delay
 * node cannot produce that today, and "keep exempt" is the non-destructive
 * answer for a marker we cannot date.
 */
export const RUN_NOT_DELAY_SUSPENDED = drizzleSql`NOT EXISTS (
  SELECT 1 FROM automation_step_runs s
  WHERE s.run_id = ${automationRuns.id}
    AND s.output->>'status' = 'delayed'
    AND CASE
          WHEN s.output->>'resumeAfter' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}'
            THEN (s.output->>'resumeAfter')::timestamptz
                 > now() - (${REAPER_DELAY_GRACE_MINUTES}::int * interval '1 minute')
          ELSE true
        END
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

    // 2. Close each reaped run's orphaned focus session through the ONE door.
    //
    //    This used to be a raw `.update(focusSessions).set({status:'closed'})`
    //    — the dual-path defect named in @synap-core/types/focus-sessions: it
    //    skipped the review pack, the session-bound ephemeral expiry and BOTH
    //    halves of the close event. `completeFocusSession` does all four.
    //
    //    The door needs a userId this worker never selected. ONE batched read
    //    (keyed on metadata.automationRunId, where openRunSession stamps it)
    //    supplies it AND carries the old status filter AND preserves the honest
    //    `sessionsClosed` count — the door's return cannot distinguish "closed
    //    now" from "was already terminal". Deliberately NOT a per-run read
    //    inside the loop: that would be an N+1 in a reaper.
    //
    //    `inArray` compiles to `… in ($1,$2,…)` (drizzle-orm binds each element
    //    separately), so this is still N bound string params and never a single
    //    array param — the pod-driver constraint the old per-run UPDATE was
    //    written around.
    const runIds = reaped.map((r) => r.id);
    const openSessions = await db
      .select({
        id: focusSessions.id,
        userId: focusSessions.userId,
        runId: drizzleSql<string>`${focusSessions.metadata}->>'automationRunId'`,
      })
      .from(focusSessions)
      .where(
        and(
          // Also match `stale`: the 24h focus-session reaper can flip a long-
          // running automation session active→stale before this per-run reaper
          // fires (e.g. if this worker was down > 24h). Without `stale` here the
          // run's session would keep closedAt=NULL forever. Terminal statuses
          // (closed/failed/cancelled) are excluded here and would no-op in the
          // door anyway.
          drizzleSql`${focusSessions.status} IN ('active', 'stale')`,
          inArray(
            drizzleSql`${focusSessions.metadata}->>'automationRunId'`,
            runIds
          )
        )
      );

    let sessionsClosed = 0;
    for (const { id, userId } of openSessions) {
      const result = await closeSessionViaDoor({
        sessionId: id,
        userId,
        // DELIBERATELY 'closed', not 'failed'. The run row above is force-failed,
        // so 'failed' would arguably be the more honest session verdict — but
        // `isFocusSessionLifecycleClose` (api's permission-check.ts) recognises
        // the lifecycle-close escape ONLY on `status === "closed"`, so changing
        // the verdict here would quietly narrow a governance escape as a side
        // effect of a routing fix. This change is about the four MISSING
        // effects; the verdict question is reported separately.
        terminalStatus: "closed",
        summary: STALE_RUN_ERROR_MESSAGE,
      });
      if (result) sessionsClosed += 1;
    }

    // 3. Narrate every timed-out run into its channel (idempotent, non-throwing
    //    — Wave 3.N1). Iterates `reaped`, NOT the sessions above: a run with no
    //    open session still gets narrated, exactly as before. `reason:
    //    "timeout"` forces the timeout copy/class even though the row now reads
    //    `failed`. Respects narrationMode `off`; `failures`/`changes` post it (a
    //    timeout is a failure). The internal claim guarantees no double-post if
    //    the executor also finalized.
    for (const { id } of reaped) {
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
