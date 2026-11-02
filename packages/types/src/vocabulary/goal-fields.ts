/**
 * The goal-field words, in a file that imports nothing, so a dependency-free
 * leaf (the lens section labels, the renderables catalog) can read them
 * without pulling the whole vocabulary. Re-exported by the vocabulary index:
 * import them from there anywhere else.
 */

/**
 * A GOAL'S FIELDS as a person reads them — on the New goal forms, the goal
 * page, the CLI (slop.md must-fix, 2026-10-24). Keyed by the stored field
 * (`project_tracks`, 0345). The end state is "What done looks like": "Success
 * looks like" stays the space brief's interview field
 * ({@link SPACE_BRIEF_FIELD_LABELS}), so no two fields share a name.
 * "Done when" is the goal page's criteria section, spelled once
 * (`LENS_SECTION_LABELS.doneWhen` reads it from here).
 */
export const GOAL_FIELD_LABELS = {
  endState: "What done looks like",
  criteria: "Done when",
  workKind: "Kind of work",
  uncertainty: "How well the way is known",
  dropConditions: "Drop it if",
} as const satisfies Readonly<Record<string, string>>;
