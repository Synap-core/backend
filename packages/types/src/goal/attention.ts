/**
 * THE goal attention derivation (goals that run, plan 1ad1cecc): which ONE
 * group a goal sits in for the person looking, why it needs them, and the
 * summary sentence over a list ("2 need you · 1 failing · 5 run on their own").
 * The Goals collection's filters and order (`./collection.ts`) and Relay's tab
 * groups read it; no surface re-derives a group.
 *
 *   needs_you   — open, and it waits on THIS person: in review and they judge
 *                 it, it waits on their input / approval / access
 *                 (`goalWaitsOnViewer`), or its workers' runs wait on their
 *                 approval (they own or judge it).
 *   failing     — open, and its workers are failing, or the pod turned one off
 *                 after failures in a row (`goalRunHealth` failing | off).
 *   running     — open, and at least one worker is on: it runs on its own.
 *   until_done  — open, and no worker at all: it is worked until its criteria
 *                 are met ("Until it's done" = no worker).
 *   off         — nothing runs: the goal ended (closed or dropped), or every
 *                 worker it has is paused.
 *
 * One group per goal, first match in that order (an ended goal is `off`
 * before anything else: it needs nobody). The groups partition the list, so
 * their counts add up to it.
 *
 * PURE: no React, no DOM, no fetching.
 */
import { isTrackClosed } from "../units/index.js";
import {
  resolveGoalAttentionGroupLabel,
  goalAttentionCountWords,
} from "../vocabulary/index.js";
import type { GoalRunsRollup } from "../workers/goal.js";
import { IN_REVIEW_MARK, waitingOnMarks } from "./marks.js";
import {
  goalWaitsOnViewer,
  viewerIsJudge,
  viewerMayStaff,
  type GoalLike,
} from "./model.js";

export const GOAL_ATTENTION_GROUPS = [
  "needs_you",
  "failing",
  "running",
  "until_done",
  "off",
] as const;
export type GoalAttentionGroup = (typeof GOAL_ATTENTION_GROUPS)[number];

/** The fields of a goal the derivation reads — the pod's list row fits as is. */
export type GoalAttentionGoal = Pick<
  GoalLike,
  "status" | "inReview" | "waitingOn" | "participants"
>;

/**
 * The runs part a goal is read with (`tracks.list` `include: ["runs"]`).
 * `null` / absent = the read did not include runs: the goal is grouped by its
 * status and marks only, and {@link goalAttention} says so (`runsRead`).
 */
export type GoalAttentionRuns = Pick<
  GoalRunsRollup,
  "health" | "workerCount" | "runningCount" | "pendingApprovals"
>;

export interface GoalNeedsYou {
  /** How many things wait on the viewer (0 = nothing). */
  count: number;
  /** The first reason, in words ("In review", "Waiting on approval", "2 runs to approve"); null at 0. */
  reason: string | null;
}

/**
 * What waits on THIS viewer in a goal, counted. Ended goals need nobody. The
 * goal's own person waits (its "Waiting on …" marks that a person answers)
 * and its workers' run approvals are counted separately: a pending proposal
 * of a worker run is not a goal mark.
 */
export function goalNeedsYou(
  goal: GoalAttentionGoal,
  runs: GoalAttentionRuns | null | undefined,
  viewerId: string | null
): GoalNeedsYou {
  if (isTrackClosed(goal) || !viewerId) return { count: 0, reason: null };
  const viewer = { userId: viewerId, kind: "person" as const };
  const reasons: string[] = [];
  let count = 0;
  if (goal.inReview === true && viewerIsJudge(goal, viewer)) {
    count += 1;
    reasons.push(IN_REVIEW_MARK.label);
  }
  if (goalWaitsOnViewer(goal, viewerId)) {
    const marks = waitingOnMarks(goal.waitingOn);
    const own = marks.reduce((n, m) => n + (m.count ?? 1), 0);
    count += Math.max(own, 1);
    if (marks[0]) reasons.push(marks[0].label);
  }
  const approvals = runs?.pendingApprovals ?? 0;
  if (approvals > 0 && viewerMayStaff(goal, viewer)) {
    count += approvals;
    reasons.push(goalAttentionCountWords("run_approvals", approvals));
  }
  return { count, reason: reasons[0] ?? null };
}

/** THE group of one goal for one viewer (see the module header for the rule). */
export function goalAttentionGroup(
  goal: GoalAttentionGoal,
  runs: GoalAttentionRuns | null | undefined,
  viewerId: string | null = null
): GoalAttentionGroup {
  if (isTrackClosed(goal)) return "off";
  if (goalNeedsYou(goal, runs, viewerId).count > 0) return "needs_you";
  if (!runs) return "until_done";
  if (runs.health === "failing" || runs.health === "off") return "failing";
  if (runs.runningCount > 0) return "running";
  if (runs.workerCount === 0) return "until_done";
  return "off";
}

export interface GoalAttention {
  group: GoalAttentionGroup;
  /** The group in words, through the vocabulary door. */
  label: string;
  needsYou: GoalNeedsYou;
  /**
   * False when the goal was read without its runs: `failing` / `running` /
   * `off` (paused) cannot be known, so the goal falls in `until_done` and the
   * host should ask for `include: ["runs"]` ({@link goalFilterQuery}).
   */
  runsRead: boolean;
}

/** The group, its words and the needs-you count, in one reading. */
export function goalAttention(
  goal: GoalAttentionGoal,
  runs: GoalAttentionRuns | null | undefined,
  viewerId: string | null = null
): GoalAttention {
  const group = goalAttentionGroup(goal, runs, viewerId);
  return {
    group,
    label: resolveGoalAttentionGroupLabel(group),
    needsYou: goalNeedsYou(goal, runs, viewerId),
    runsRead: runs != null,
  };
}

/** How many goals sit in each group. */
export type GoalAttentionCounts = Record<GoalAttentionGroup, number>;

export function goalAttentionCounts(
  groups: readonly GoalAttentionGroup[]
): GoalAttentionCounts {
  const counts = Object.fromEntries(
    GOAL_ATTENTION_GROUPS.map((g) => [g, 0])
  ) as GoalAttentionCounts;
  for (const g of groups) counts[g] += 1;
  return counts;
}

/** The groups the summary sentence names, in its order (`off` is never said). */
const SUMMARY_GROUPS = [
  "needs_you",
  "failing",
  "running",
  "until_done",
] as const;

/**
 * "2 need you · 1 failing · 5 run on their own · 3 until done" — a clause
 * per group with goals in it, zero clauses dropped; null when no clause is
 * left (every goal is off, or there are none).
 */
export function goalAttentionSummary(
  counts: GoalAttentionCounts
): string | null {
  const parts = SUMMARY_GROUPS.filter((g) => counts[g] > 0).map((g) =>
    goalAttentionCountWords(g, counts[g])
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}
