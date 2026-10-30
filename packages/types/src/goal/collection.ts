/**
 * THE goals collection — Work › Goals on the desk and the Goals page on the
 * phone, one rule (surfaces F2, UX-14): which filters exist and what each
 * means, which list read each needs, the order, and one goal as a row.
 *
 *   Open               — not ended (every status but Closed and Dropped);
 *   In review          — open, and the pod says it waits on its judge;
 *   Waiting on         — open, and it wears a "Waiting on …" mark (a reason
 *                        whose count is above zero — the mark's own rule);
 *   Closed or dropped  — ended; the read must ask for dropped goals too
 *                        (`tracks.list` leaves `archived` out by default).
 *
 * Order, for every filter: in review first (a judgement waits), then the goals
 * waiting on the viewer (`goalWaitsOnViewer`), then the most recently changed.
 *
 * A surface keeps only its layout (chips, segments, sections); the meaning,
 * the words and the order are here.
 *
 * PURE: no React, no DOM, no fetching.
 */
import type { LensRow } from "../lens/index.js";
import { isTrackClosed } from "../units/index.js";
import {
  nounInSentence,
  resolveObjectNoun,
  resolveTrackStatusLabel,
} from "../vocabulary/index.js";
import { goalStatusMark, IN_REVIEW_MARK, type GoalMarkView } from "./marks.js";
import {
  goalCriteriaCount,
  goalInsideMarks,
  goalIsWaiting,
  goalWaitsOnViewer,
  viewerIsJudge,
  type GoalLike,
} from "./model.js";

export const GOAL_FILTERS = ["open", "in_review", "waiting", "ended"] as const;
export type GoalFilter = (typeof GOAL_FILTERS)[number];

/** Where the collection lands: every goal still open. */
export const DEFAULT_GOAL_FILTER: GoalFilter = "open";

/** The filters' words — the marks' own words where a mark exists. Copy, not stored values. */
export function goalFilterLabel(filter: GoalFilter): string {
  switch (filter) {
    case "open":
      return "Open";
    case "in_review":
      return IN_REVIEW_MARK.label;
    case "waiting":
      return "Waiting on";
    case "ended":
      return `${resolveTrackStatusLabel("completed")} or ${nounInSentence(resolveTrackStatusLabel("archived"))}`;
  }
}

/**
 * The list read a filter needs (`tracks.list` input). Dropped goals come back
 * only when asked (`includeArchived`); a closed one always does.
 */
export function goalFilterQuery(filter: GoalFilter): {
  includeArchived: boolean;
} {
  return { includeArchived: filter === "ended" };
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
};

/** Does `goal` belong under `filter`? In review and Waiting on are marks INSIDE an open goal. */
export function goalMatchesFilter(
  goal: GoalListGoal,
  filter: GoalFilter
): boolean {
  const ended = isTrackClosed(goal);
  if (filter === "ended") return ended;
  if (ended) return false;
  if (filter === "in_review") return goal.inReview === true;
  if (filter === "waiting") return goalIsWaiting(goal);
  return true;
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
  /** The status chip, with the verdict once it ended. */
  status: GoalMarkView;
  /** "In review", one "Waiting on …" per reason — marks inside Active. */
  marks: GoalMarkView[];
  /** "3 of 5 met · 1 claimed", or `null` for a lasting goal / unread marks. */
  count: string | null;
  /** It waits on THIS viewer: in review and they judge it, or `goalWaitsOnViewer`. */
  waitsOnYou: boolean;
  /** The row for the lens kit's `AttentionRow`. */
  row: LensRow;
}

/**
 * One goal as a row. The goal is the door, its count the reason line, its
 * project the source when the host names it (off the project's own scope —
 * pass `null` on it). A row that waits on the viewer is `blocking`; the rest
 * are `happening`. The status mark is drawn by the host from `status` (a
 * goal's status is not a unit state); `state` only feeds the data attribute.
 */
export function goalCollectionRow<G extends GoalListGoal>(
  goal: G,
  viewerId: string | null,
  projectName: string | null = null
): GoalCollectionRow<G> {
  const count = goalCriteriaCount(goal).label;
  const viewer = { userId: viewerId, kind: "person" as const };
  const waitsOnYou =
    !isTrackClosed(goal) &&
    ((goal.inReview === true && viewerIsJudge(goal, viewer)) ||
      goalWaitsOnViewer(goal, viewerId));
  return {
    goal,
    status: goalStatusMark(goal),
    marks: goalInsideMarks(goal),
    count,
    waitsOnYou,
    row: {
      key: `goal:${goal.id}`,
      cls: waitsOnYou ? "blocking" : "happening",
      state: isTrackClosed(goal) ? { terminal: true } : { everStarted: true },
      objectKind: "track",
      title: goalTitle(goal),
      reason: count,
      repeat: null,
      source:
        projectName && goal.projectId
          ? { kind: "project", id: goal.projectId, label: projectName }
          : null,
      occurredAt: goal.updatedAt ?? null,
      verb: null,
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
  query: { includeArchived: boolean };
  /** The goals under the filter, in THE order. */
  rows: GoalCollectionRow<G>[];
}

/** The collection for one filter and one viewer. */
export function goalCollection<G extends GoalListGoal>({
  goals,
  filter,
  viewerId,
  projectNameOf,
}: GoalCollectionInput<G>): GoalCollection<G> {
  const rows = goals
    .filter((g) => goalMatchesFilter(g, filter))
    .map((g) =>
      goalCollectionRow(
        g,
        viewerId,
        g.projectId ? (projectNameOf?.(g.projectId) ?? null) : null
      )
    )
    .map((r, i) => ({
      r,
      i,
      tier: r.goal.inReview === true ? 0 : r.waitsOnYou ? 1 : 2,
    }))
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
      count: goals.filter((g) => goalMatchesFilter(g, key)).length,
      selected: key === filter,
    })),
    query: goalFilterQuery(filter),
    rows,
  };
}
