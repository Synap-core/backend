/**
 * "This week" — the ONE rule that PROPOSES the goals a person pins for the
 * week (decision 89d53f13 + D4: up to 3 pinned goals, proposed each Monday,
 * on the desk's rail and in the phone's Monday prompt). It proposes; the
 * person keeps or changes. It never reshuffles what they kept.
 *
 * Order, each tier only adding goals not already picked, stopping at 3:
 *   1. last week's pins that are still active, IN THE PERSON'S ORDER;
 *   2. goals in review where the viewer is the judge (a judgement waits);
 *   3. goals waiting on the viewer: the viewer owns or judges it and it
 *      waits on input, an approval or access (a person's act — the pod
 *      derives these from slots owed by a person and pending proposals), or
 *      the viewer was asked to take part and has not answered;
 *   4. active goals the viewer owns.
 * Inside tiers 2–4, the most recently active goal first.
 *
 * Below the proposal: the section's words ("This week's goals" — never the
 * phone calendar's "This week"), what it shows (`thisWeekView`: the person's
 * pins read by id, failed reads kept, a proposal only over no pins) and the
 * pin button's state (`goalPinState`).
 *
 * PURE: no React, no DOM, no clock read (`now` is accepted so both surfaces
 * call one shape; the order is relative and needs none).
 */
import { RAIL_GOAL_PINS_MAX, trackStatusCategory } from "../units/index.js";
import { THIS_WEEK_LABEL } from "../vocabulary/index.js";
import {
  goalRoles,
  goalWaitsOnViewer,
  viewerIsJudge,
  type GoalLike,
} from "./model.js";

/** The most goals the week proposes (D4) — the rail's pin cap, one literal (types/units). */
export const THIS_WEEK_MAX = RAIL_GOAL_PINS_MAX;

export interface ThisWeekInput {
  /** The goals the viewer can see (`tracks.list` with no project). */
  goals: ReadonlyArray<GoalLike & { updatedAt: string }>;
  /** Last week's pinned goal ids, in the order the person kept them. */
  lastWeekPins: readonly string[];
  /** The person the week is for. */
  viewerId: string;
  /** The moment of proposing (unused by the order; see the module header). */
  now?: Date;
}

const isActive = (g: { status: string }) =>
  trackStatusCategory(g.status) === "active";

const ms = (iso: string) => {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
};

/** Up to {@link THIS_WEEK_MAX} goal ids, in the order to propose them. */
export function proposeThisWeek({
  goals,
  lastWeekPins,
  viewerId,
}: ThisWeekInput): string[] {
  const viewer = { userId: viewerId, kind: "person" as const };
  const byId = new Map(goals.map((g) => [g.id, g]));
  const picked: string[] = [];
  const take = (ids: Iterable<string>) => {
    for (const id of ids) {
      if (picked.length >= THIS_WEEK_MAX) return;
      if (!picked.includes(id)) picked.push(id);
    }
  };
  // Within a tier, the most recently active first — never the list's order.
  const live = goals
    .filter(isActive)
    .sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
  take(
    lastWeekPins.filter((id) => {
      const g = byId.get(id);
      return !!g && isActive(g);
    })
  );
  take(
    live
      .filter((g) => g.inReview === true && viewerIsJudge(g, viewer))
      .map((g) => g.id)
  );
  take(live.filter((g) => goalWaitsOnViewer(g, viewerId)).map((g) => g.id));
  take(live.filter((g) => goalRoles(g).ownerId === viewerId).map((g) => g.id));
  return picked;
}

// ── "This week's goals": the words, the slots, the pin button ──────────────

/**
 * The words — one name for the goal pins on both surfaces, distinct from the
 * phone's calendar page "This week" (surfaces F7). The section's name is the
 * vocabulary's (`THIS_WEEK_LABEL`); the rest is copy, not stored values.
 */
export const THIS_WEEK_COPY = {
  /** The section on Home / the rail — "This week's goals". */
  title: THIS_WEEK_LABEL,
  /** The act on a goal page. */
  pin: "Pin for this week",
  unpin: "Unpin from this week",
  /** Why a 4th pin is refused, before the pod says it. */
  full: "This week's goals are full. Unpin one first.",
  /** Provenance of the section — the canvas: "proposed Monday, kept by you · Swap a goal". */
  kept: "Kept by you",
  proposed: "Proposed for this week",
  swap: "Swap a goal",
} as const;

/** One pinned goal's read, by id — never looked up in a page of a list. */
export type ThisWeekRead<G> =
  | { state: "read"; goal: G }
  | { state: "loading" }
  /** The read failed: the slot stays, with its retry — it still holds its place in the cap. */
  | { state: "failed" };

export interface ThisWeekSlot<G> {
  id: string;
  read: ThisWeekRead<G>;
}

/**
 * The goals the proposal reads (the pod-wide list), as read — never a bare
 * array, so "not read yet" and "the read failed" are never an empty list.
 */
export type ThisWeekGoalsRead<G> =
  | { state: "read"; goals: readonly G[] }
  | { state: "loading" }
  | { state: "failed" };

export interface ThisWeekView<G> {
  /**
   * `kept` = the person's pins; `proposed` = nothing pinned, the shared
   * proposal; `unread` = the pins could not be read yet (or failed), or —
   * nothing pinned — the goals to propose from are still being read;
   * `failed` = nothing pinned and the goals to propose from could not be
   * read: a failure with its retry, never an empty week. Nothing is
   * proposed over a read nobody could see.
   */
  source: "kept" | "proposed" | "unread" | "failed";
  /** The provenance line ("Kept by you" / "Proposed for this week"); `null` while unread or failed. */
  provenance: string | null;
  slots: ThisWeekSlot<G>[];
}

/**
 * The goals "This week's goals" shows. The person's pins win, read BY ID in
 * their order (`readPinned`), at most {@link THIS_WEEK_MAX}; a pin whose read
 * failed keeps its slot. Only when nothing is pinned does the shared
 * proposal fill it ({@link proposeThisWeek} over the pod-wide list) — a
 * proposal never replaces what the person kept. A list still being read is
 * `unread`, a failed one `failed`: neither is an empty week.
 */
export function thisWeekView<
  G extends GoalLike & { updatedAt: string },
>(input: {
  /** The person's goal pins in order (`useGoalPins`); `null` = not read. */
  pinnedIds: readonly string[] | null;
  readPinned: (id: string) => ThisWeekRead<G>;
  /** The goals the viewer can see, as read — read only to propose. */
  goals: ThisWeekGoalsRead<G>;
  viewerId: string | null;
  lastWeekPins?: readonly string[];
}): ThisWeekView<G> {
  if (input.pinnedIds === null)
    return { source: "unread", provenance: null, slots: [] };
  if (input.pinnedIds.length > 0) {
    return {
      source: "kept",
      provenance: THIS_WEEK_COPY.kept,
      slots: input.pinnedIds
        .slice(0, THIS_WEEK_MAX)
        .map((id) => ({ id, read: input.readPinned(id) })),
    };
  }
  if (input.goals.state === "loading")
    return { source: "unread", provenance: null, slots: [] };
  if (input.goals.state === "failed")
    return { source: "failed", provenance: null, slots: [] };
  const { goals } = input.goals;
  const byId = new Map(goals.map((g) => [g.id, g]));
  const ids = input.viewerId
    ? proposeThisWeek({
        goals,
        lastWeekPins: input.lastWeekPins ?? [],
        viewerId: input.viewerId,
      })
    : [];
  return {
    source: "proposed",
    provenance: THIS_WEEK_COPY.proposed,
    slots: ids.map((id) => ({
      id,
      read: { state: "read" as const, goal: byId.get(id)! },
    })),
  };
}

/** The pin button on a goal page: pinned or not, and whether a pin would be refused (the week is full). */
export function goalPinState(
  goalId: string,
  pinnedIds: readonly string[] | null
): {
  pinned: boolean;
  full: boolean;
  label: string;
  refusal: string | null;
} | null {
  if (pinnedIds === null) return null;
  const pinned = pinnedIds.includes(goalId);
  const full = !pinned && pinnedIds.length >= THIS_WEEK_MAX;
  return {
    pinned,
    full,
    label: pinned ? THIS_WEEK_COPY.unpin : THIS_WEEK_COPY.pin,
    refusal: full ? THIS_WEEK_COPY.full : null,
  };
}
