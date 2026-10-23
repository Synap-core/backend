/**
 * THE LOOP — a goal proposes its next run (work model W4, decision 1,
 * 2026-10-23): "The track proposes its next session while criteria are unmet
 * (budgeted; stops and asks when the same criterion fails twice)."
 *
 * ONE function decides and acts: {@link runGoalLoop}. Its rule is the pure
 * `decideGoalNextRun` (@synap-core/types/units); everything it reads already
 * exists — the goal row (its `loop`, 0350, set by a person through the goal's
 * governed write door), the runs filed into it and their `session_evaluations`
 * rows (`loadGoalRuns`, the read W2's marks use), and the proposals it filed.
 *
 * WHEN it runs — only from seams that already exist, never a scheduler of its
 * own:
 *   · a run filed into the goal closes (`focus_session.closed`) and the goal
 *     changes status or has its loop switched on (`track.update`) — the
 *     reactor `goal-loop-reactor.ts`;
 *   · the hourly focus-session reaper tick (@synap/jobs, through the
 *     `registerGoalLoopSweeper` slot) — {@link sweepGoalLoops}, for the goals
 *     whose budget or a pending proposal held them, and for a criterion the
 *     judge sent back.
 *
 * WHAT it does:
 *   · PROPOSES the next run through the existing session start door
 *     (`createFocusSession`, `focus_session/create`) with `goalLoopOf`, which
 *     forces a proposal — it never starts a run, whoever switched the loop on.
 *     The run is filed into the goal, carries every unmet criterion by the
 *     SAME key (so the goal's marks count its grades) and the goal's end
 *     state as its brief, in the name of the goal's owner (`goalOwnerToAsk`).
 *   · Or HOLDS, saying why. One hold acts: `stopped` — a required criterion
 *     failed in two runs — asks the owner once per stop
 *     (`track.loop_stopped`, see {@link askOwnerLoopStopped}).
 *
 * Budget: the proposals carrying `goalLoopOf` = this goal, filed in the last
 * {@link GOAL_LOOP_WINDOW_DAYS} days, whatever became of them; one pending
 * at a time. KNOWN LIMIT: two triggers racing on the same goal in the same
 * instant can both pass the one-pending check (no lock is held across the
 * start door, which commits on its own connections) — the budget still caps
 * the week.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  and,
  eq,
  or,
  notifications,
  projectTracks,
  projects,
  proposals,
  drizzleSql,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import type { ProjectTrack } from "@synap/database/schema";
import {
  GOAL_LOOP_WINDOW_DAYS,
  decideGoalNextRun,
  deriveGoalCriteria,
  goalCriteriaFailedTwice,
  readGoalLoop,
  trackStatusCategory,
  type GoalLoopHold,
  type GoalLoopStop,
} from "@synap-core/types/units";
import { SESSION_TITLE_MAX } from "@synap-core/types/focus-sessions";
import type { SessionCriterion } from "@synap/playbooks";
import {
  goalOwnerToAsk,
  loadGoalRuns,
  readEndState,
  readGoalCriteria,
  type GoalCriterion,
} from "./goal-content.js";
import { createFocusSession } from "../focus-sessions/create-session.js";
import { NotificationService } from "../../notifications/NotificationService.js";

const logger = createLogger({ module: "goal-loop" });

/**
 * The registry type the stop produces — under a lowercase `notificationType`
 * key, so the source-scan producer allowlist sees the literal.
 */
const notificationType = "track.loop_stopped" as const;
export const GOAL_LOOP_STOPPED_TYPE = notificationType;

/**
 * One ask per STOP: the goal, the criterion, and the run that made it the
 * second failure. The same stop re-read on every tick is the same key; a new
 * stop (after the owner answered and it failed twice again) is a new one.
 */
export function goalLoopStopGroupKey(goalId: string, stop: GoalLoopStop) {
  return `${GOAL_LOOP_STOPPED_TYPE}:${goalId}:${stop.key}:${stop.sessionIds.at(-1)}`;
}

export type GoalLoopRunResult =
  | { status: "proposed"; proposalId: string; carry: string[] }
  | { status: "held"; hold: GoalLoopHold; stoppedOn?: GoalLoopStop[] }
  | { status: "not_found" };

/** The name of the run the loop proposes — what the review queue shows. */
export function goalNextRunTitle(goalName: string): string {
  const title = `Next run: ${goalName.trim()}`;
  return title.length > SESSION_TITLE_MAX
    ? `${title.slice(0, SESSION_TITLE_MAX - 1)}…`
    : title;
}

/**
 * The brief of the run the loop proposes: the goal, its end state, and what is
 * not met yet — the run's own criteria repeat the last part as checks.
 */
export function goalNextRunBrief(input: {
  goalName: string;
  endState: string | null;
  unmet: ReadonlyArray<Pick<SessionCriterion, "statement">>;
}): string {
  return [
    `Move the goal "${input.goalName.trim()}" closer to done.`,
    ...(input.endState ? [`Done looks like: ${input.endState}`] : []),
    "Not met yet:",
    ...input.unmet.map((c) => `- ${c.statement}`),
  ].join("\n");
}

/** A goal criterion as a run carries it: the session shape, no judge's decision. */
function asRunCriterion(c: GoalCriterion): SessionCriterion {
  const { acceptance: _decided, ...criterion } = c;
  return criterion;
}

/** The proposals this goal's loop filed: still pending, and in the window. */
async function loopProposalCounts(
  goalId: string
): Promise<{ pending: number; recent: number }> {
  const loopOf = drizzleSql`${proposals.data}->'data'->>'goalLoopOf'`;
  const recentSql = drizzleSql<boolean>`${proposals.createdAt} > now() - (${GOAL_LOOP_WINDOW_DAYS}::int * interval '1 day')`;
  const rows = await db
    .select({ status: proposals.status, recent: recentSql })
    .from(proposals)
    .where(
      and(
        drizzleSql`${loopOf} = ${goalId}`,
        or(eq(proposals.status, ProposalStatus.PENDING), recentSql)
      )
    );
  return {
    pending: rows.filter((r) => r.status === ProposalStatus.PENDING).length,
    recent: rows.filter((r) => r.recent === true).length,
  };
}

/**
 * THE loop, for one goal: decide, then propose the next run or hold. Acts as
 * the pod (no caller): the proposal is filed in the owner's name and waits on
 * a person. Never throws for a hold; a failed read or write throws.
 */
export async function runGoalLoop(goalId: string): Promise<GoalLoopRunResult> {
  const [row] = await db
    .select({ track: projectTracks, workspaceId: projects.workspaceId })
    .from(projectTracks)
    .innerJoin(projects, eq(projects.id, projectTracks.projectId))
    .where(eq(projectTracks.id, goalId))
    .limit(1);
  if (!row) return { status: "not_found" };
  const track = row.track as ProjectTrack;
  const loop = readGoalLoop(track.loop);
  // The cheap holds first — no run read for a goal whose loop is off.
  if (!loop.on) return { status: "held", hold: "loop_off" };

  const criteria = readGoalCriteria(track.criteria);
  const { runsOf } = await loadGoalRuns([track]);
  const runs = runsOf.get(track.id) ?? [];
  const states = deriveGoalCriteria(criteria, runs);
  const counts = await loopProposalCounts(track.id);
  const decision = decideGoalNextRun({
    loop,
    category: trackStatusCategory(track.status),
    criteria,
    marks: states,
    openRuns: runs.filter((r) => r.open).length,
    pendingProposals: counts.pending,
    proposedThisWeek: counts.recent,
    stops: goalCriteriaFailedTwice(criteria, runs, loop.onAt),
  });

  if (!decision.propose) {
    if (decision.hold === "stopped" && decision.stoppedOn) {
      await askOwnerLoopStopped(
        track,
        row.workspaceId,
        decision.stoppedOn,
        criteria
      );
    }
    return {
      status: "held",
      hold: decision.hold,
      ...(decision.stoppedOn ? { stoppedOn: decision.stoppedOn } : {}),
    };
  }

  const carried = criteria.filter((c) => decision.carry.includes(c.key));
  const result = await createFocusSession({
    userId: await goalOwnerToAsk(track),
    workspaceId: row.workspaceId,
    projectId: track.projectId,
    trackId: track.id,
    title: goalNextRunTitle(track.name),
    goal: goalNextRunBrief({
      goalName: track.name,
      endState: readEndState(track.endState),
      unmet: carried,
    }),
    criteria: carried.map(asRunCriterion),
    goalLoopOf: track.id,
  });
  if (result.status !== "proposed") {
    // `goalLoopOf` forces a proposal; a run that STARTED would break the
    // loop's one promise. Loud, never silent.
    logger.error(
      { goalId: track.id, status: result.status },
      "goal loop: the start door did not file a proposal"
    );
    throw new Error(
      `The goal loop must propose its next run, but the start door answered "${result.status}".`
    );
  }
  return {
    status: "proposed",
    proposalId: result.proposalId,
    carry: decision.carry,
  };
}

/**
 * Tell the goal's owner the loop stopped — ONCE per stop
 * ({@link goalLoopStopGroupKey}): the reaper re-reads a stopped goal every
 * hour, and the ask must not repeat. An unread row is an item in the owner's
 * Needs you (the registry default). Through the one notification door; a
 * failure is logged, never thrown (the hold stands either way).
 */
export async function askOwnerLoopStopped(
  track: Pick<ProjectTrack, "id" | "name" | "userId">,
  workspaceId: string | null,
  stops: readonly GoalLoopStop[],
  criteria: readonly GoalCriterion[]
): Promise<void> {
  const owner = await goalOwnerToAsk(track);
  for (const stop of stops) {
    const groupKey = goalLoopStopGroupKey(track.id, stop);
    try {
      const [already] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, owner),
            eq(notifications.type, GOAL_LOOP_STOPPED_TYPE),
            eq(notifications.groupKey, groupKey)
          )
        )
        .limit(1);
      if (already) continue;
      const criterion = criteria.find((c) => c.key === stop.key);
      await NotificationService.create({
        type: notificationType,
        userId: owner,
        workspaceId,
        sourceType: "track",
        // The GOAL is the destination: the owner grades, changes the
        // criterion, or switches the loop on again there.
        sourceId: track.id,
        groupKey,
        data: {
          trackId: track.id,
          trackName: track.name,
          criterionKey: stop.key,
          criterionStatement: criterion?.statement ?? stop.key,
          runs: stop.sessionIds.length,
          sessionIds: stop.sessionIds,
        },
      });
    } catch (err) {
      logger.error(
        { err, goalId: track.id, criterionKey: stop.key },
        "goal loop: could not ask the owner after a stop"
      );
    }
  }
}

/** Goals one sweep looks at, at most — the rest wait for the next tick. */
export const GOAL_LOOP_SWEEP_LIMIT = 200;

/**
 * The hourly re-check (the focus-session reaper's tick): every ACTIVE goal
 * whose loop is on and that has criteria — an open run is `runGoalLoop`'s
 * own hold (`run_open`, the shared terminal-status rule), never re-spelled
 * here. One goal's failure
 * never stops the others. Returns what it did, for the reaper's log.
 */
export async function sweepGoalLoops(): Promise<{
  checked: number;
  proposed: number;
  failed: number;
}> {
  const goals = await db
    .select({ id: projectTracks.id })
    .from(projectTracks)
    .where(
      and(
        eq(projectTracks.status, "active"),
        drizzleSql`(${projectTracks.loop} ->> 'on') = 'true'`,
        drizzleSql`jsonb_typeof(${projectTracks.criteria}) = 'array' AND jsonb_array_length(${projectTracks.criteria}) > 0`
      )
    )
    .orderBy(projectTracks.updatedAt)
    .limit(GOAL_LOOP_SWEEP_LIMIT);
  let proposed = 0;
  let failed = 0;
  for (const g of goals) {
    try {
      const r = await runGoalLoop(g.id);
      if (r.status === "proposed") proposed++;
    } catch (err) {
      failed++;
      logger.error({ err, goalId: g.id }, "goal loop sweep: one goal failed");
    }
  }
  return { checked: goals.length, proposed, failed };
}
