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
 * The capture-back / session-finalize doors both UPDATE ... WHERE the status is
 * LIVE, so a late report against a reaped (now 'failed') run cleanly no-ops
 * instead of double-writing — this reaper is safe to run alongside them.
 *
 * WHO HOLDS THE RUN decides the verdict (D6, 2026-10-11). A run the pod handed
 * to the IS is FAILED when it goes quiet: an IS turn that never captured back
 * is a dead worker, and the parent automation's breakers must see it. A run an
 * EXTERNAL agent holds (Claude Code following "AI Dev Session") is only QUIET —
 * that agent comes back on its own clock, and one did: three outputs and
 * progress 90 landed six hours after the reaper failed its run. Such a run is
 * marked `stale` with its session (not terminal: no `completedAt`, no parent
 * settle, the session stays open), and the next write attributed to that
 * session revives both (`reviveStaleSession`, api).
 */

import {
  db,
  and,
  eq,
  inArray,
  drizzleSql,
  playbookRuns,
  focusSessions,
  sessionWaitsOnPersonWhere,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { closeSessionViaDoor } from "../utils/session-close.js";
import { settleParentAutomationRunFromChild } from "../utils/automation-parent-settle.js";

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

/**
 * The run is held by an EXTERNAL agent, not by a worker the pod launched:
 *   • `executor = 'external-agent'` — dispatched through an agent binding, or
 *   • its session was OPENED BY an external key-auth client: `metadata.clientKey`
 *     is `key:<apiKeyId>…`. `clientKeyForApiKey` (@synap/database, the ONE
 *     client-identity resolver) returns `key:` for every MCP / Hub REST key and
 *     NOTHING for the IS's `is_internal` key, whose sessions carry the
 *     `agent:<id>` fallback instead. This arm is what catches a session an
 *     agent STARTED from a playbook (`start_session` + `templateId`): that run
 *     copies the playbook's `executor` — `is-agent` on every playbook the pod
 *     has — although nothing was dispatched to the IS.
 * A run `runPlaybook` dispatched to the IS matches neither (its session is
 * minted by `instantiateSession`, which stamps no client) and keeps the
 * failure verdict.
 *
 * AND its session is still OPEN (active / paused / stale): `stale` promises a
 * revival, and only an open session can be written to again. A run under a
 * closed or missing session has nothing to come back to — it fails as before.
 */
export const RUN_HELD_BY_EXTERNAL_AGENT = drizzleSql`(
  (
    ${playbookRuns.executor} = 'external-agent'
    OR EXISTS (
      SELECT 1 FROM focus_sessions fs
      WHERE fs.id = ${playbookRuns.sessionId}
        AND fs.metadata ->> 'clientKey' LIKE 'key:%'
    )
  )
  AND EXISTS (
    SELECT 1 FROM focus_sessions fs
    WHERE fs.id = ${playbookRuns.sessionId}
      AND fs.status IN ('active', 'paused', 'stale')
  )
)`;

/** A running run past the window whose session shows no recent activity. */
const RUN_IS_STALE = and(
  eq(playbookRuns.status, "running"),
  drizzleSql`${playbookRuns.startedAt} < now() - (${PLAYBOOK_RUN_REAPER_STALE_HOURS}::int * interval '1 hour')`,
  RUN_SESSION_NOT_ACTIVE
);

/** Called by the cron scheduler every ~30 minutes. */
export async function handlePlaybookRunReaper(): Promise<void> {
  try {
    // 00. UNPARK: a waiting run whose session no longer owes the person
    //     (answered, closed, gone) goes back to `running`, so the sweeps
    //     below judge it like any other run. The completing doors finish a
    //     live run directly (`LIVE_RUN_STATUSES`); this catches the rest.
    const unparked = await db
      .update(playbookRuns)
      .set({ status: "running" })
      .where(
        and(
          eq(playbookRuns.status, "waiting_on_you"),
          drizzleSql`NOT ${sessionWaitsOnPersonWhere(playbookRuns.sessionId)}`
        )
      )
      .returning({ id: playbookRuns.id });
    if (unparked.length > 0) {
      logger.info(
        { unparked: unparked.length },
        "Playbook run reaper resumed runs no longer waiting on the person"
      );
    }

    // 0. A quiet run whose session waits on the person (an owed slot, or an
    //    agent question in its room still unanswered — an external agent
    //    asks and STOPS until the answer starts its next run) is WAITING ON
    //    YOU, not
    //    orphaned (W2 calm): a session waiting on the person is quiet by
    //    definition, so `RUN_SESSION_NOT_ACTIVE` alone read it as dead. Marked
    //    first so the fail sweep (status = 'running') can never reach it; its
    //    session is left open. No `completedAt`: it did not finish.
    const waiting = await db
      .update(playbookRuns)
      .set({ status: "waiting_on_you" })
      .where(
        and(RUN_IS_STALE, sessionWaitsOnPersonWhere(playbookRuns.sessionId))
      )
      .returning({ id: playbookRuns.id });
    if (waiting.length > 0) {
      logger.info(
        { waiting: waiting.length },
        "Playbook run reaper marked runs waiting on the person"
      );
    }

    // 0b. A quiet run an EXTERNAL agent holds is STALE, never failed: the
    //     agent works on its own clock and may still deliver. Marked before
    //     the fail sweep so it can never reach it. No `completedAt` (it did not
    //     finish) and no parent settle (stale is not terminal). Its session is
    //     marked stale too — open, reopenable — instead of closed, so the
    //     agent's next write revives it rather than landing in a closed room.
    const staled = await db
      .update(playbookRuns)
      .set({ status: "stale" })
      .where(and(RUN_IS_STALE, RUN_HELD_BY_EXTERNAL_AGENT))
      .returning({ id: playbookRuns.id, sessionId: playbookRuns.sessionId });
    if (staled.length > 0) {
      const staleSessionIds = staled
        .map((r) => r.sessionId)
        .filter((id): id is string => !!id);
      // Status only, the focus-session reaper's own write: `updatedAt` stays
      // the last real activity. Not a lifecycle exit, so not the close door.
      if (staleSessionIds.length > 0) {
        await db
          .update(focusSessions)
          .set({ status: "stale" })
          .where(
            and(
              inArray(focusSessions.id, staleSessionIds),
              drizzleSql`${focusSessions.status} IN ('active', 'paused')`
            )
          );
      }
      logger.info(
        { staled: staled.length },
        "Playbook run reaper marked external-agent runs stale"
      );
    }

    // 1. Force-fail stale running runs whose session is no longer active.
    const reaped = await db
      .update(playbookRuns)
      .set({
        status: "failed",
        error: STALE_RUN_ERROR_MESSAGE,
        completedAt: new Date(),
      })
      .where(RUN_IS_STALE)
      .returning({ id: playbookRuns.id, sessionId: playbookRuns.sessionId });

    if (reaped.length === 0) {
      logger.debug("No stale playbook runs to reap");
      return;
    }

    // 1b. A reaped run that an automation started is a FAILED CHILD: settle
    //     its parent run from it, so the rule's breakers see the failure
    //     (the incident's runs all died here, and the parent read "completed").
    //     Never throws; one parent read per reaped run.
    for (const { id } of reaped) {
      await settleParentAutomationRunFromChild({ playbookRunId: id });
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
