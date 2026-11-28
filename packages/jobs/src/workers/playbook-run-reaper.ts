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
 * the same activity signal `focus-session-reaper` keys on — OR a post by a
 * person or an agent in the session's own room (founder Q14, finding
 * c573d32d: a lane that only posts in its room never moves `updatedAt`, and
 * was failed while it worked). A run older than the
 * threshold whose session is NO LONGER active/paused-and-fresh is presumed
 * orphaned and force-failed; a genuinely long external-agent run that keeps its
 * session warm is EXEMPT. The threshold is generous (24h) precisely because an
 * external agent turn is legitimately long — a false-fail would abandon live
 * work, so we err toward waiting. A run held by the pod's own AI (the IS) is
 * judged after 2 hours instead (`IS_RUN_REAPER_QUIET_HOURS`): its turns last
 * minutes and report their end, failed included.
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
 * session revives both (`reviveStaleSession`, api). A run an AGENT holds
 * (`holder.kind = 'agent'`) on a session bound to no client is the same
 * external agent: a wave's lane carries no client key, because its lead's
 * conversation keeps it (`session-client-binding.ts`). It goes stale, never
 * failed (founder Q14).
 *
 * A RUN NOBODY CLAIMED is `blocked`, never failed. A run is born `queued`
 * with its holder and is `running` only once that holder claims it. Past its
 * holder's window — Synap AI {@link WORK_CLOCK}.live, anyone else
 * {@link WORK_CLOCK}.quiet, counted from when the holder was named — it moves
 * to `blocked` with the reason and who was passed over, and the person is
 * asked (`run-blocked-ask.ts`, api). The clock does not run while its session
 * waits on the person (a hand-off waiting for approval included), nor while
 * its Synap AI turn still waits in pg-boss for a worker.
 */

import {
  db,
  and,
  or,
  eq,
  inArray,
  drizzleSql,
  playbookRuns,
  focusSessions,
  users,
  sessionWaitsOnPersonWhere,
  stageRunWaitsWhere,
  stageRunAgentLiveWhere,
  setRunStatus,
  setSessionStatus,
  MessageAuthorType,
} from "@synap/database";
import { SESSION_ROOM_CONTEXT_TYPE } from "@synap/database/channel-visibility";
import { createLogger } from "@synap-core/core";
import { WORK_CLOCK, workClockIn } from "@synap-core/types/work-clock";
import { PLANNED_SESSION_STATUS } from "@synap-core/types/focus-sessions";
import type { RunHolder } from "@synap-core/types/units";
import {
  passedOverLine,
  SESSION_POST_META_KEY,
  type RunOn,
} from "@synap-core/types/agents";
import { a2aiTurnPendingIn } from "./a2ai-response-trigger.js";
import { closeSessionViaDoor } from "../utils/session-close.js";
import { settleParentAutomationRunFromChild } from "../utils/automation-parent-settle.js";

const logger = createLogger({ module: "playbook-run-reaper" });

export const PLAYBOOK_RUN_REAPER_QUEUE = "playbook-run-reaper";
/** Every 5 min: an unclaimed Synap AI run is blocked after {@link WORK_CLOCK}.live. */
export const PLAYBOOK_RUN_REAPER_CRON = "*/5 * * * *";

/** How long a holder has to claim a run, by who it is. */
export function claimWindowMinutes(kind: RunHolder["kind"]): number {
  return workClockIn(kind === "synap_ai" ? "live" : "quiet", "minutes");
}

/**
 * The run's session is a PLANNED step (`forming`, founder P1/P4): it has not
 * started, so its run is not late, unclaimed or orphaned — it waits for the
 * pod to wake the step (api `planned-wake.ts`). Every sweep below leaves it.
 */
export const RUN_SESSION_NOT_PLANNED = drizzleSql`NOT EXISTS (
  SELECT 1 FROM focus_sessions fs
  WHERE fs.id = ${playbookRuns.sessionId}
    AND fs.status = ${PLANNED_SESSION_STATUS}
)`;

/**
 * A `queued` run past its holder's claim window, whose session does not wait
 * on the person and has no A2AI turn still waiting for a worker. A run with
 * no `holder` is judged from its start, as Synap AI's.
 */
export const RUN_UNCLAIMED = and(
  eq(playbookRuns.status, "queued"),
  drizzleSql`coalesce((${playbookRuns.holder} ->> 'assignedAt')::timestamptz, ${playbookRuns.startedAt})
    < now() - (CASE WHEN coalesce(${playbookRuns.holder} ->> 'kind', 'synap_ai') = 'synap_ai'
                    THEN ${claimWindowMinutes("synap_ai")}::int
                    ELSE ${claimWindowMinutes("agent")}::int END * interval '1 minute')`,
  drizzleSql`NOT ${sessionWaitsOnPersonWhere(playbookRuns.sessionId)}`,
  drizzleSql`NOT ${a2aiTurnPendingIn(playbookRuns.sessionId)}`,
  RUN_SESSION_NOT_PLANNED
)!;

/**
 * Mark each unclaimed run `blocked`, one move per run so each carries its own
 * reason: who was waited for, how long, and who was passed over. The move
 * records a hold on the person; `run-blocked-ask.ts` (api) asks them.
 */
async function blockUnclaimedRuns(): Promise<number> {
  const rows = await db
    .select({
      id: playbookRuns.id,
      holder: playbookRuns.holder,
      runOn: playbookRuns.runOn,
    })
    .from(playbookRuns)
    .where(RUN_UNCLAIMED);
  if (rows.length === 0) return 0;
  const holderIds = [
    ...new Set(
      rows
        .map((r) => (r.holder as RunHolder | null)?.id)
        .filter((v): v is string => !!v)
    ),
  ];
  const names = new Map(
    (holderIds.length
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, holderIds))
      : []
    ).map((u) => [u.id, u.name])
  );
  let blocked = 0;
  for (const r of rows) {
    const holder = (r.holder as RunHolder | null) ?? null;
    const kind = holder?.kind ?? "synap_ai";
    const who =
      kind === "synap_ai"
        ? "Synap AI"
        : kind === "none"
          ? "nobody"
          : ((holder?.id ? names.get(holder.id) : null) ?? "its agent");
    const runOn = (r.runOn as RunOn | null) ?? null;
    const passed = [
      ...(runOn?.passedOver ? [runOn.passedOver] : []),
      ...(runOn?.runnerPassedOver ?? []),
    ].map(passedOverLine);
    const reason =
      `Nobody started this run: ${who} did not pick it up within ${claimWindowMinutes(kind)} minutes.` +
      (passed.length > 0 ? ` Passed over: ${passed.join("; ")}.` : "");
    const { rows: moved } = await setRunStatus(db, {
      runId: r.id,
      where: RUN_UNCLAIMED,
      from: "queued",
      to: "blocked",
      actor: { kind: "system" },
      reason,
      defaultHold: { on: "person", reason },
    });
    blocked += moved.length;
  }
  return blocked;
}

/**
 * A 'running' playbook run older than this whose session shows no recent
 * activity is presumed orphaned. Generous by design (see file header): an
 * external-agent turn is legitimately long, so we wait a full day before
 * force-failing to avoid abandoning live work.
 */
export const PLAYBOOK_RUN_REAPER_STALE_HOURS = workClockIn("stale", "hours");

const STALE_RUN_ERROR_MESSAGE =
  "Timed out: the run never finalized (worker died, or the external agent never captured back). Auto-failed by the playbook run reaper.";

/**
 * A run is still being ACTIVELY WORKED (and must NOT be reaped) iff its session
 * is active/paused AND was touched within the window, or its ROOM was: a
 * person or an agent posted in it (founder Q14, finding c573d32d). An agent
 * that reports in its room every 20 minutes is working, although a room post
 * never moves the session's `updatedAt`. Referencing
 * `playbook_runs.session_id` correlates this to the UPDATE target. A run with a
 * null/terminal/stale/quiet session makes the EXISTS false → NOT EXISTS true →
 * reapable. Interval arithmetic in SQL (no bound Date param — postgres.js 3.4.8
 * crashes on Date binds on the pod image, same as automation-run-reaper).
 *
 * The room post that counts is narrow, so a dead run is never kept alive by
 * someone else's words:
 *   • the session's OWN room (`contextObjectType = 'focus_session'`, its id):
 *     a borrowed channel other work also posts in is not its activity;
 *   • written by a person or an agent: the pod's own notices (`bot`: recall,
 *     dispatch, run summaries, status notices) are not;
 *   • not a coordination post from another session (`sessionPost` stamp): a
 *     lead writing to a lane says nothing about the lane's agent;
 *   • not deleted, not ephemeral.
 * Read on `messages_channel_timestamp_idx` (channel_id, timestamp).
 */
function sessionQuietFor(hours: number) {
  return drizzleSql`NOT EXISTS (
  SELECT 1 FROM focus_sessions fs
  WHERE fs.id = ${playbookRuns.sessionId}
    AND fs.status IN ('active', 'paused')
    AND (
      fs.updated_at > now() - (${hours}::int * interval '1 hour')
      OR EXISTS (
        SELECT 1 FROM channels room
        JOIN messages m ON m.channel_id = room.id
        WHERE room.id = fs.channel_id
          AND room.context_object_type = ${SESSION_ROOM_CONTEXT_TYPE}
          AND room.context_object_id = fs.id
          AND m.timestamp > now() - (${hours}::int * interval '1 hour')
          AND m.author_type IN (${MessageAuthorType.HUMAN}, ${MessageAuthorType.AI_AGENT})
          AND m.deleted_at IS NULL
          AND m.ephemeral IS NOT TRUE
          AND (m.metadata -> ${SESSION_POST_META_KEY}::text) IS NULL
      )
    )
)`;
}

/**
 * A run one of whose steps WAITS — on a child run or on tools being installed
 * (its open `session_stage_runs` row, 0422) — is waiting, not idle: a parent
 * paused on a child for days must not be reaped (runner engine spec 7111934d,
 * risk 3). Never stale-marked, never failed, whatever its holder's window.
 */
export const RUN_STAGE_NOT_WAITING = drizzleSql`NOT ${stageRunWaitsWhere(playbookRuns.sessionId)}`;

/**
 * A run one of whose steps is HANDED to an agent on a computer that shows as
 * LIVE (a hub key of it used within 15 minutes, the hand-off roster's `live`:
 * `stageRunAgentLiveWhere`) is being worked, however long the agent goes
 * without writing to the session (founder, finding 58b10b9a). It is exempt
 * from every window; once the agent is silent that long, the window applies.
 */
export const RUN_STAGE_AGENT_NOT_LIVE = drizzleSql`NOT ${stageRunAgentLiveWhere(playbookRuns.sessionId)}`;

/**
 * A running run started more than `hours` ago whose session went quiet and
 * none of whose steps waits or is worked by a live agent.
 */
function runQuietFor(hours: number) {
  return and(
    eq(playbookRuns.status, "running"),
    drizzleSql`${playbookRuns.startedAt} < now() - (${hours}::int * interval '1 hour')`,
    sessionQuietFor(hours),
    RUN_STAGE_NOT_WAITING,
    RUN_STAGE_AGENT_NOT_LIVE,
    RUN_SESSION_NOT_PLANNED
  )!;
}

export const RUN_SESSION_NOT_ACTIVE = sessionQuietFor(
  PLAYBOOK_RUN_REAPER_STALE_HOURS
);

/**
 * A run with no holder reads as Synap AI's, as in {@link RUN_UNCLAIMED}. The
 * `coalesce` is load-bearing: a NULL here would make `NOT RUN_EXTERNAL_HOLDER`
 * NULL and drop every holder-less run from the IS window.
 */
const AGENT_HOLDER: RunHolder["kind"] = "agent";

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
 *     has — although nothing was dispatched to the IS; or
 *   • an AGENT holds it (`holder.kind = 'agent'`) and its session is bound to
 *     NO client (no `metadata.clientKey`): the agent that started it from a
 *     conversation that keeps another session (a wave's lane, whose lead
 *     holds the conversation: `decideNewSessionClientKey`), or the agent it
 *     was handed to. Founder Q14: such a session goes stale, never failed;
 *     giving lanes a client key was the rejected option (a client key is an
 *     attachment, not a holder).
 * A run `runPlaybook` dispatched to the IS matches none (its session is
 * minted by `instantiateSession`, which stamps no client, and its holder is
 * `synap_ai`) and keeps the failure verdict. So does an automation's run:
 * its session carries the automation's `startedByAgentId` stamp and no client
 * key too, but its run is held by `synap_ai`, which is why the holder — not
 * the `startedByAgentId` stamp — names an agent-held run here. A session the
 * IS itself starts carries its `agent:<id>` / `is:` client key, so a run it
 * holds as an agent keeps the failure verdict as well. Stated limit: a planned
 * child the IS starts under its OWN session is bound to no client (the lane
 * rule), so its run waits the 24-hour window and goes stale.
 *
 * AND its session is still OPEN (active / paused / stale): `stale` promises a
 * revival, and only an open session can be written to again. A run under a
 * closed or missing session has nothing to come back to — it fails as before.
 */
const RUN_EXTERNAL_HOLDER = drizzleSql`(
  ${playbookRuns.executor} = 'external-agent'
  OR EXISTS (
    SELECT 1 FROM focus_sessions fs
    WHERE fs.id = ${playbookRuns.sessionId}
      AND fs.metadata ->> 'clientKey' LIKE 'key:%'
  )
  OR (
    coalesce(${playbookRuns.holder} ->> 'kind', 'synap_ai') = ${AGENT_HOLDER}
    AND EXISTS (
      SELECT 1 FROM focus_sessions fs
      WHERE fs.id = ${playbookRuns.sessionId}
        AND fs.metadata ->> 'clientKey' IS NULL
    )
  )
)`;

export const RUN_HELD_BY_EXTERNAL_AGENT = drizzleSql`(
  ${RUN_EXTERNAL_HOLDER}
  AND EXISTS (
    SELECT 1 FROM focus_sessions fs
    WHERE fs.id = ${playbookRuns.sessionId}
      AND fs.status IN ('active', 'paused', 'stale')
  )
)`;

/** A running run past the window whose session shows no recent activity. */
const RUN_IS_STALE = runQuietFor(PLAYBOOK_RUN_REAPER_STALE_HOURS);

/**
 * A run the pod handed to its OWN AI (the IS) is quiet much sooner: an IS turn
 * lasts minutes and reports its end, so a run nobody moved for 2 hours is a
 * dead worker (finding db27cac2: outage runs stayed active for a day). An
 * external agent works on its own clock and keeps the 24-hour window. Not a
 * work-clock rung: the run reaper's own clock.
 */
export const IS_RUN_REAPER_QUIET_HOURS = 2;

/** An IS-held running run past its 2-hour window whose session went quiet. */
const IS_RUN_IS_QUIET = and(
  runQuietFor(IS_RUN_REAPER_QUIET_HOURS),
  drizzleSql`NOT ${RUN_EXTERNAL_HOLDER}`
);

/** A run the sweeps below judge: past its holder's window, session quiet. */
const RUN_IS_REAPABLE = or(RUN_IS_STALE, IS_RUN_IS_QUIET)!;

/** Called by the cron scheduler every 5 minutes. */
export async function handlePlaybookRunReaper(): Promise<void> {
  try {
    // 1. UNCLAIMED: a run its holder never took is blocked on the person.
    //    Its own failure never stops the sweeps below.
    try {
      const blocked = await blockUnclaimedRuns();
      if (blocked > 0) {
        logger.info(
          { blocked },
          "Playbook run reaper blocked runs nobody claimed"
        );
      }
    } catch (err) {
      logger.error({ err }, "Playbook run reaper: the unclaimed sweep failed");
    }

    // 2. UNPARK: a waiting run whose session no longer owes the person
    //     (answered, closed, gone) goes back to `running`, so the sweeps
    //     below judge it like any other run. The completing doors finish a
    //     live run directly (`LIVE_RUN_STATUSES`); this catches the rest.
    // Every sweep moves through the ONE run door (`setRunStatus`): one
    // transition per row, owed in the sweep's own transaction.
    const { rows: unparked } = await setRunStatus(db, {
      where: drizzleSql`NOT ${sessionWaitsOnPersonWhere(playbookRuns.sessionId)}`,
      from: "waiting_on_you",
      to: "running",
      actor: { kind: "system" },
      reason: "Its session no longer waits on the person.",
    });
    if (unparked.length > 0) {
      logger.info(
        { unparked: unparked.length },
        "Playbook run reaper resumed runs no longer waiting on the person"
      );
    }

    // 3. A quiet run whose session waits on the person (an owed slot, or an
    //    agent question in its room still unanswered — an external agent
    //    asks and STOPS until the answer starts its next run) is WAITING ON
    //    YOU, not
    //    orphaned (W2 calm): a session waiting on the person is quiet by
    //    definition, so `RUN_SESSION_NOT_ACTIVE` alone read it as dead. Marked
    //    first so the fail sweep (status = 'running') can never reach it; its
    //    session is left open. No `completedAt`: it did not finish.
    const { rows: waiting } = await setRunStatus(db, {
      where: and(
        RUN_IS_REAPABLE,
        sessionWaitsOnPersonWhere(playbookRuns.sessionId)
      ),
      from: "running",
      to: "waiting_on_you",
      actor: { kind: "system" },
      reason: "Its session waits on the person.",
      defaultHold: { on: "person", reason: "Its session waits on the person." },
    });
    if (waiting.length > 0) {
      logger.info(
        { waiting: waiting.length },
        "Playbook run reaper marked runs waiting on the person"
      );
    }

    // 4. A quiet run an EXTERNAL agent holds is STALE, never failed: the
    //     agent works on its own clock and may still deliver. Marked before
    //     the fail sweep so it can never reach it. No `completedAt` (it did not
    //     finish) and no parent settle (stale is not terminal). Its session is
    //     marked stale too — open, reopenable — instead of closed, so the
    //     agent's next write revives it rather than landing in a closed room.
    const { rows: staled } = await setRunStatus(db, {
      where: and(RUN_IS_STALE, RUN_HELD_BY_EXTERNAL_AGENT),
      from: "running",
      to: "stale",
      actor: { kind: "system" },
      reason: "Its external agent went quiet.",
      defaultHold: { on: "agent", reason: "Its external agent went quiet." },
    });
    if (staled.length > 0) {
      const staleSessionIds = staled
        .map((r) => r.sessionId)
        .filter((id): id is string => !!id);
      // Status only, the focus-session reaper's own write: `updatedAt` stays
      // the last real activity. Not a lifecycle exit, so not the close door;
      // the one session status write, so each owes its transition.
      if (staleSessionIds.length > 0) {
        await setSessionStatus(db, {
          where: inArray(focusSessions.id, staleSessionIds),
          from: ["active", "paused"],
          to: "stale",
          actor: { kind: "system" },
          reason: "Its run's external agent went quiet.",
          defaultHold: {
            on: "nobody",
            reason: "Its run's external agent went quiet.",
          },
        });
      }
      logger.info(
        { staled: staled.length },
        "Playbook run reaper marked external-agent runs stale"
      );
    }

    // 5. Force-fail stale running runs whose session is no longer active.
    const { rows: reaped } = await setRunStatus(db, {
      where: RUN_IS_REAPABLE,
      from: "running",
      to: "failed",
      actor: { kind: "system" },
      reason: "The run never finalized: auto-failed by the run reaper.",
      set: { error: STALE_RUN_ERROR_MESSAGE, completedAt: new Date() },
    });

    if (reaped.length === 0) {
      logger.debug("No stale playbook runs to reap");
      return;
    }

    // 5b. A reaped run that an automation started is a FAILED CHILD: settle
    //     its parent run from it, so the rule's breakers see the failure
    //     (the incident's runs all died here, and the parent read "completed").
    //     Never throws; one parent read per reaped run.
    for (const { id } of reaped) {
      await settleParentAutomationRunFromChild({ playbookRunId: id });
    }

    // 6. Close each reaped run's orphaned session through the ONE door.
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
