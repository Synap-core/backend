/**
 * HOW A PERSON REACHES A GOAL, AND HOW ONE IS MADE — the pure half (work
 * model W5b, 2026-10-23).
 *
 *   This week (D4)      — goal pins live in the person's rail pins (key
 *                         `track:<id>`), at most {@link RAIL_GOAL_PINS_MAX};
 *                         the rail's other pins are unchanged.
 *   Make it a goal (D2) — a `goal` / `objective` / `okr` entity a pod already
 *                         holds converts into a goal (a track), once. The
 *                         lineage is the entity's `promoted_to` edge to the
 *                         track; the entity itself is kept, never changed.
 *
 * PURE and dependency-free: the pod, Relay and the browser import the same
 * answer, so the desk and the phone cannot disagree on when a button shows.
 */

/** The most goals a person pins for the week (D4). The rail holds more pins. */
export const RAIL_GOAL_PINS_MAX = 3;

/** The rail pin key of a goal — THE one spelling (`unpin` / `reorder` take it). */
export function goalRailPinKey(trackId: string): string {
  return `track:${trackId}`;
}

/**
 * The kinds "Make it a goal" converts: Life OS `goal`, Enterprise
 * `objective`, Project Management `okr` (catalog decision D2-A).
 */
export const GOAL_CONVERTIBLE_KINDS = ["goal", "objective", "okr"] as const;
export type GoalConvertibleKind = (typeof GOAL_CONVERTIBLE_KINDS)[number];

export function isGoalConvertibleKind(
  slug: string | null | undefined
): slug is GoalConvertibleKind {
  return (
    typeof slug === "string" &&
    (GOAL_CONVERTIBLE_KINDS as readonly string[]).includes(slug)
  );
}

/** What the predicate reads of an entity — structural, any copy fits. */
export interface GoalConvertibleEntity {
  /** The entity's kind (its profile slug). */
  profileSlug: string | null | undefined;
  /**
   * The goals it was already made into: the ids at the far end of its
   * outgoing `promoted_to` edges to a `track` (the object graph lists them in
   * the "became" zone). Empty = never converted.
   */
  goalIds: readonly string[];
}

/**
 * THE rule for "Make it a goal": only a `goal` / `objective` / `okr` entity,
 * and only one that was not already made into a goal. The pod's convert door
 * refuses exactly what this answers `false` for.
 */
export function canConvertToGoal(entity: GoalConvertibleEntity): boolean {
  return (
    isGoalConvertibleKind(entity.profileSlug) && entity.goalIds.length === 0
  );
}
