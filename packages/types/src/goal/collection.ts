/**
 * THE goals collection — Work › Goals on the desk and the Goals page on the
 * phone, one rule (surfaces F2, UX-14; goals that run, plan 1ad1cecc): which
 * filters exist and what each means, which list read each needs, the order,
 * and one goal as a row.
 *
 * The filters are the goal attention groups (`./attention.ts`, ONE
 * derivation) plus Open:
 *
 *   Open        — not ended (every status but Closed and Dropped);
 *   Needs you   — `needs_you`: what used to be "In review" (when the viewer
 *                 judges it) and "Waiting on" (when it waits on the viewer),
 *                 plus its workers' runs waiting on the viewer's approval. A
 *                 goal that waits on someone else keeps its "Waiting on …"
 *                 mark on its row, in whatever group it sits;
 *   Repeating   — `running`: at least one worker on;
 *   Until done  — `until_done`: no worker, worked until its criteria are met;
 *   Failing     — `failing`: its workers fail, or one was turned off;
 *   Off         — `off`: what used to be "Closed or dropped", plus open goals
 *                 whose every worker is paused. The read must ask for dropped
 *                 goals too (`tracks.list` leaves `archived` out by default).
 *
 * Every filter reads the goals WITH their runs (`include: ["runs"]`).
 *
 * Order, for every filter: by attention group (needs you, failing, repeating,
 * until done, off), then the most recently changed.
 *
 * A surface keeps only its layout (chips, segments, sections); the meaning,
 * the words and the order are here.
 *
 * PURE: no React, no DOM, no fetching.
 */
import type { LensRow, LensVerb } from "../lens/index.js";
import { isTrackClosed } from "../units/index.js";
import {
  nounInSentence,
  resolveActionLabel,
  resolveGoalAttentionGroupLabel,
  resolveObjectNoun,
} from "../vocabulary/index.js";
import type { GoalRunsRollup } from "../workers/goal.js";
import {
  GOAL_ATTENTION_GROUPS,
  goalAttention,
  goalAttentionCounts,
  goalAttentionSummary,
  type GoalAttentionGroup,
  type GoalNeedsYou,
} from "./attention.js";
import { goalStatusMark, type GoalMarkView } from "./marks.js";
import { goalCriteriaCount, goalInsideMarks, type GoalLike } from "./model.js";

export const GOAL_FILTERS = [
  "open",
  "needs_you",
  "repeating",
  "until_done",
  "failing",
  "off",
] as const;
export type GoalFilter = (typeof GOAL_FILTERS)[number];

/** Where the collection lands: every goal still open. */
export const DEFAULT_GOAL_FILTER: GoalFilter = "open";

/** The attention group a filter shows; `null` for Open (every group but ended goals). */
export function goalFilterGroup(filter: GoalFilter): GoalAttentionGroup | null {
  switch (filter) {
    case "open":
      return null;
    case "repeating":
      return "running";
    default:
      return filter;
  }
}

/** The filters' words — the attention groups' own words. Copy, not stored values. */
export function goalFilterLabel(filter: GoalFilter): string {
  const group = goalFilterGroup(filter);
  return group ? resolveGoalAttentionGroupLabel(group) : "Open";
}

/** What `tracks.list` takes for a filter. */
export interface GoalFilterQuery {
  includeArchived: boolean;
  include: ["runs"];
}

/**
 * The list read a filter needs (`tracks.list` input): always with the runs;
 * dropped goals come back only when asked (`includeArchived`), so only Off
 * asks; a closed one always comes back.
 */
export function goalFilterQuery(filter: GoalFilter): GoalFilterQuery {
  return { includeArchived: filter === "off", include: ["runs"] };
}

/** The fields of a goal the collection reads — the pod's list row fits as is. */
export type GoalListGoal = Pick<
  GoalLike,
  | "id"
  | "name"
  | "status"
  | "verdict"
  | "criteria"
  | "inReview"
  | "waitingOn"
  | "participants"
> & {
  projectId?: string | null;
  updatedAt?: string | null;
  /** Its runs (`tracks.list` `include: ["runs"]`); absent / null = not read. */
  runs?: GoalRunsRollup | null;
};

/** Does `goal` belong under `filter` for this viewer? */
export function goalMatchesFilter(
  goal: GoalListGoal,
  filter: GoalFilter,
  viewerId: string | null = null
): boolean {
  const group = goalFilterGroup(filter);
  if (group === null) return !isTrackClosed(goal);
  return goalAttention(goal, goal.runs, viewerId).group === group;
}

/** A goal with no name still reads as one: "Untitled goal". */
export function goalTitle(goal: Pick<GoalLike, "name">): string {
  return (
    goal.name?.trim() ||
    `Untitled ${nounInSentence(resolveObjectNoun("track"))}`
  );
}

/** One goal as a row: the lens row + the marks drawn beside it. */
export interface GoalCollectionRow<G extends GoalListGoal = GoalListGoal> {
  goal: G;
  /** Its attention group (`goalAttentionGroup`) and the group's words. */
  group: GoalAttentionGroup;
  groupLabel: string;
  /** The status chip, with the verdict once it ended. */
  status: GoalMarkView;
  /** "In review", one "Waiting on …" per reason — marks inside Active. */
  marks: GoalMarkView[];
  /** "3 of 5 met · 1 claimed", or `null` for a lasting goal / unread marks. */
  count: string | null;
  /** Its rhythm, from its running workers ("Every Monday at 09:00 UTC"); null = nothing wakes it / not read. */
  rhythm: string | null;
  /** The runs' marks for the health strip, oldest → newest (≤ 10); empty when not read. */
  runMarks: GoalRunsRollup["marks"];
  /** What waits on the viewer, counted, and the first reason in words. */
  needsYou: GoalNeedsYou;
  /** It waits on THIS viewer (`needsYou.count > 0`). */
  waitsOnYou: boolean;
  /** False when the goal was read without its runs (`goalAttention`). */
  runsRead: boolean;
  /** The row for the lens kit's `AttentionRow`; its `verb` is the ONE verb. */
  row: LensRow;
}

const verbOf = (action: string): LensVerb => ({
  action,
  label: resolveActionLabel(action, "imperative"),
});

/**
 * The row's ONE verb: what the viewer does from the list. Needs you: Review
 * (in review), Approve (run approvals), else Answer; Failing: Open (to fix it
 * and resume it on its page). Every other row opens, with no verb.
 */
function goalRowVerb(
  goal: GoalListGoal,
  group: GoalAttentionGroup,
  needsYou: GoalNeedsYou
): LensVerb | null {
  if (group === "needs_you") {
    if (goal.inReview === true) return verbOf("review");
    if ((goal.runs?.pendingApprovals ?? 0) > 0) return verbOf("approve");
    return needsYou.count > 0 ? verbOf("answer") : null;
  }
  if (group === "failing") return verbOf("open");
  return null;
}

/**
 * One goal as a row. The goal is the door, its count the reason line (its
 * needs-you reason when it needs the viewer), its project the source when the
 * host names it (off the project's own scope — pass `null` on it). A row
 * that needs the viewer is `blocking`; the rest are `happening`. The status
 * mark is drawn by the host from `status` (a goal's status is not a unit
 * state); `state` only feeds the data attribute.
 */
export function goalCollectionRow<G extends GoalListGoal>(
  goal: G,
  viewerId: string | null,
  projectName: string | null = null
): GoalCollectionRow<G> {
  const count = goalCriteriaCount(goal).label;
  const attention = goalAttention(goal, goal.runs, viewerId);
  const waitsOnYou = attention.needsYou.count > 0;
  return {
    goal,
    group: attention.group,
    groupLabel: attention.label,
    status: goalStatusMark(goal),
    marks: goalInsideMarks(goal),
    count,
    rhythm: goal.runs?.rhythm ?? null,
    runMarks: goal.runs?.marks ?? [],
    needsYou: attention.needsYou,
    waitsOnYou,
    runsRead: attention.runsRead,
    row: {
      key: `goal:${goal.id}`,
      cls: waitsOnYou ? "blocking" : "happening",
      state: isTrackClosed(goal) ? { terminal: true } : { everStarted: true },
      objectKind: "track",
      title: goalTitle(goal),
      reason: (waitsOnYou ? attention.needsYou.reason : null) ?? count,
      repeat: null,
      source:
        projectName && goal.projectId
          ? { kind: "project", id: goal.projectId, label: projectName }
          : null,
      occurredAt: goal.updatedAt ?? null,
      verb: goalRowVerb(goal, attention.group, attention.needsYou),
      door: { kind: "track", id: goal.id },
      count: 1,
    },
  };
}

const ms = (iso: string | null | undefined) => {
  const t = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isNaN(t) ? 0 : t;
};

export interface GoalFilterChip {
  key: GoalFilter;
  label: string;
  /** Over the goals READ so far — a paged read may hold more. */
  count: number;
  selected: boolean;
}

export interface GoalCollectionInput<G extends GoalListGoal> {
  /** The goals read (`tracks.list`, with {@link goalFilterQuery} for the filter shown). */
  goals: readonly G[];
  filter: GoalFilter;
  /** The person looking — orders what waits on them; `null` = unknown (nothing is theirs). */
  viewerId: string | null;
  /** A project's name for the row's source; absent or `null` ⇒ no source drawn. */
  projectNameOf?: (projectId: string) => string | null;
}

export interface GoalCollection<G extends GoalListGoal> {
  filter: GoalFilter;
  /** Every filter, in order, with its words and count. A host may hide an empty one, never rename it. */
  filters: GoalFilterChip[];
  /** The read the shown filter needs. */
  query: GoalFilterQuery;
  /** The goals under the filter, in THE order. */
  rows: GoalCollectionRow<G>[];
  /** "2 need you · 1 failing · 5 run on their own" over the goals read; null when none is said. */
  summary: string | null;
  /** How many goals were read WITHOUT their runs (0 when the read asked for them). */
  runsUnread: number;
}

/** The collection for one filter and one viewer. */
export function goalCollection<G extends GoalListGoal>({
  goals,
  filter,
  viewerId,
  projectNameOf,
}: GoalCollectionInput<G>): GoalCollection<G> {
  const all = goals.map((g) =>
    goalCollectionRow(
      g,
      viewerId,
      g.projectId ? (projectNameOf?.(g.projectId) ?? null) : null
    )
  );
  const inFilter = (r: GoalCollectionRow<G>, f: GoalFilter) => {
    const group = goalFilterGroup(f);
    return group === null ? !isTrackClosed(r.goal) : r.group === group;
  };
  const rows = all
    .filter((r) => inFilter(r, filter))
    .map((r, i) => ({ r, i, tier: GOAL_ATTENTION_GROUPS.indexOf(r.group) }))
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        ms(b.r.goal.updatedAt) - ms(a.r.goal.updatedAt) ||
        a.i - b.i
    )
    .map(({ r }) => r);
  return {
    filter,
    filters: GOAL_FILTERS.map((key) => ({
      key,
      label: goalFilterLabel(key),
      count: all.filter((r) => inFilter(r, key)).length,
      selected: key === filter,
    })),
    query: goalFilterQuery(filter),
    rows,
    summary: goalAttentionSummary(goalAttentionCounts(all.map((r) => r.group))),
    runsUnread: all.filter((r) => !r.runsRead).length,
  };
}
