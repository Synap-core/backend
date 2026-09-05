/**
 * Playbook Run Reaper
 *
 * The playbook counterpart to `automation-run-reaper`. `run-playbook.ts` writes
 * a `playbook_runs` row `status:'running'` BEFORE dispatching to the executor,
 * and for an `external-agent` / `is-agent` executor the run STAYS 'running' until
 * an async capture-back (`POST /api/hub/runs/{runId}/capture`, or the
 * focus-session finalize) flips it terminal. Three ways it never does:
 *   • a setup-window throw or worker death between the insert and the terminal
 *     UPDATE orphans the row,
 *   • the external agent abandons the task and never captures back,
 *   • the IS turn hangs / crashes.
 * `automation-run-reaper` only covers `automation_runs`, so these orphaned
 * playbook runs sat 'running' forever (live: 98 runs stuck > 24h) with no reaper.
 *
 * Staleness signal: `playbook_runs` has no `updatedAt`, so "actively worked" is
 * read off the linked focus_sessions.updatedAt (every real step touches it) —
 * the same activity signal `focus-session-reaper` keys on. A run older than the
 * threshold whose session is NO LONGER active/paused-and-fresh is presumed
 * orphaned and force-failed; a genuinely long external-agent run that keeps its
 * session warm is EXEMPT. The threshold is generous (24h) precisely because an
 * external agent turn is legitimately long — a false-fail would abandon live
 * work, so we err toward waiting.
 *
 * The capture-back / session-finalize doors both UPDATE ... WHERE status =
 * 'running', so a late report against a reaped (now 'failed') run cleanly no-ops
 * instead of double-writing — this reaper is safe to run alongside them.
 */

import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  playbookRuns,
  focusSessions,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { closeSessionViaDoor } from "../utils/session-close.js";

const logger = createLogger({ module: "playbook-run-reaper" });

export const PLAYBOOK_RUN_REAPER_QUEUE = "playbook-run-reaper";
/** Every 30min — playbook runs are long-lived; no need for the 5min automation cadence. */
export const PLAYBOOK_RUN_REAPER_CRON = "*/30 * * * *";

/**
 * A 'running' playbook run older than this whose session shows no recent
 * activity is presumed orphaned. Generous by design (see file header): an
 * external-agent turn is legitimately long, so we wait a full day before
 * force-failing to avoid abandoning live work.
 */
export const PLAYBOOK_RUN_REAPER_STALE_HOURS = 24;

const STALE_RUN_ERROR_MESSAGE =
  "Timed out: the run never finalized (worker died, or the external agent never captured back). Auto-failed by the playbook run reaper.";

/**
 * A run is still being ACTIVELY WORKED (and must NOT be reaped) iff its session
 * is active/paused AND was touched within the stale window. Referencing
 * `playbook_runs.session_id` correlates this to the UPDATE target. A run with a
 * null/terminal/stale/quiet session makes the EXISTS false → NOT EXISTS true →
 * reapable. Interval arithmetic in SQL (no bound Date param — postgres.js 3.4.8
 * crashes on Date binds on the pod image, same as automation-run-reaper).
 */
export const RUN_SESSION_NOT_ACTIVE = drizzleSql`NOT EXISTS (
  SELECT 1 FROM focus_sessions fs
  WHERE fs.id = ${playbookRuns.sessionId}
    AND fs.status IN ('active', 'paused')
    AND fs.updated_at > now() - (${PLAYBOOK_RUN_REAPER_STALE_HOURS}::int * interval '1 hour')
)`;

/** Called by the cron scheduler every ~30 minutes. */
export async function handlePlaybookRunReaper(): Promise<void> {
  try {
    // 1. Force-fail stale running runs whose session is no longer active.
    const reaped = await db
      .update(playbookRuns)
      .set({
        status: "failed",
        error: STALE_RUN_ERROR_MESSAGE,
        completedAt: new Date(),
      })
      .where(
        and(
          eq(playbookRuns.status, "running"),
          drizzleSql`${playbookRuns.startedAt} < now() - (${PLAYBOOK_RUN_REAPER_STALE_HOURS}::int * interval '1 hour')`,
          RUN_SESSION_NOT_ACTIVE
        )
      )
      .returning({ id: playbookRuns.id, sessionId: playbookRuns.sessionId });

    if (reaped.length === 0) {
      logger.debug("No stale playbook runs to reap");
      return;
    }

    // 2. Close each reaped run's orphaned session through the ONE door.
    //
    //    This used to be a raw `.update(focusSessions).set({status:'closed'})`,
    //    which is the dual-path defect named in @synap-core/types/focus-sessions:
    //    it skipped the review pack, the session-bound ephemeral expiry and BOTH
    //    halves of the close event. `completeFocusSession` does all four.
    //
    //    The door needs a userId this worker's RETURNING cannot yield, and it
    //    carries its OWN already-terminal guard — so ONE batched read replaces
    //    both the missing userId and the old `IN ('active','paused','stale')`
    //    WHERE clause, and gives the honest `sessionsClosed` telemetry (the
    //    door's return cannot distinguish "closed now" from "was already
    //    terminal": both come back terminal). Deliberately NOT a per-session
    //    read inside the loop — that would be an N+1 in a reaper.
    //
    //    `inArray` compiles to `id in ($1,$2,…)` — one bound string param per
    //    id, NOT a single array param (drizzle-orm binds each element), so it
    //    respects the pod driver's array-param constraint the old per-run UPDATE
    //    was written around.
    const sessionIds = reaped
      .map((r) => r.sessionId)
      .filter((id): id is string => !!id);

    let sessionsClosed = 0;
    if (sessionIds.length > 0) {
      const openSessions = await db
        .select({ id: focusSessions.id, userId: focusSessions.userId })
        .from(focusSessions)
        .where(
          and(
            inArray(focusSessions.id, sessionIds),
            // Also match 'stale' so a session the focus-session reaper already
            // flipped active→stale still gets a closedAt. Terminal statuses
            // (closed/failed/cancelled) are excluded here and would no-op in the
            // door anyway.
            drizzleSql`${focusSessions.status} IN ('active', 'paused', 'stale')`
          )
        );

      for (const { id, userId } of openSessions) {
        const result = await closeSessionViaDoor({
          sessionId: id,
          userId,
          // DELIBERATELY 'closed', not 'failed'. The run row is force-failed
          // above, so 'failed' would arguably be the more honest session
          // verdict — but `isFocusSessionLifecycleClose` (api's
          // permission-check.ts) recognises the lifecycle-close escape ONLY on
          // `status === "closed"`, so switching the verdict here would quietly
          // narrow a governance escape as a side effect of a routing fix. This
          // change is about the four MISSING effects, not about re-verdicting
          // sessions; the verdict question is reported separately.
          terminalStatus: "closed",
          summary: STALE_RUN_ERROR_MESSAGE,
        });
        if (result) sessionsClosed += 1;
      }
    }

    logger.info(
      { reaped: reaped.length, sessionsClosed },
      "Playbook run reaper swept stale runs"
    );
  } catch (err) {
    logger.error({ err }, "Playbook run reaper failed");
    throw err; // Let pg-boss handle retry.
  }
}
