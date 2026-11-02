/**
 * The lens tables that need nothing else: the five attention classes, the
 * section order and its headings, the caps, the four empty answers. Split out
 * of `classes.ts` so a dependency-free leaf (the renderables catalog) can
 * derive from them; `classes.ts` re-exports every name, so import them from
 * `@synap-core/types/lens` as before. This file imports only `goal-fields`,
 * which imports nothing (the renderables leaf guard holds that).
 */

import { GOAL_FIELD_LABELS } from "../vocabulary/goal-fields.js";

/** In SECTION order (the order {@link LENS_SECTION_ORDER} draws them). */
export const ATTENTION_CLASSES = [
  "blocking",
  "happening",
  "produced",
  "proposed",
  "happened",
] as const;
export type AttentionClass = (typeof ATTENTION_CLASSES)[number];

/**
 * Below the top, in this order, at every scope (skill §3). Produced sits above
 * Happened because outcomes outrank process; Proposed sits below the work
 * because ignoring it is free. `structure` (Map | Steps | Zoom) exists only on
 * a project / track lens; `data` only where the scope owns data.
 *
 * A GOAL (track) page answers, in order (experience north star v2, W5
 * 2026-10-23): how close — `doneWhen` (its criteria) · what waits on you —
 * `blocking` · who is on it — `participants` · what it made — `produced`.
 * Those two keys exist only on a track lens ({@link lensSections}); every
 * other scope keeps the order it had. A session keeps its own criteria
 * section ("Done means", `SESSION_STEP_SECTIONS`) after Produced.
 */
export const LENS_SECTION_ORDER = [
  "doneWhen",
  "blocking",
  "participants",
  "happening",
  "produced",
  "structure",
  "proposed",
  "happened",
  "data",
] as const;
export type LensSection = (typeof LENS_SECTION_ORDER)[number];

/** The section headings — one spelling for the header's count doors AND the sections. */
export const LENS_SECTION_LABELS = {
  // A goal's criteria — the goal field's own word (vocabulary door).
  doneWhen: GOAL_FIELD_LABELS.criteria,
  blocking: "Needs you",
  participants: "Who's on it",
  happening: "Happening",
  produced: "Produced",
  // The work-structure slot (Map | Steps | Zoom) is the PLAN (founder default,
  // 2026-10-05): "Work" already names the app, its page and its breadcrumb.
  structure: "Plan",
  proposed: "Proposed",
  happened: "Happened",
  data: "Data",
} as const satisfies Record<LensSection, string>;

/**
 * The four answers a section gives when it has nothing to draw
 * (`.claude/rules/ui-composition.md` §2): OMIT (draw nothing), INVITE (the
 * reader can fill it), EXPLAIN (only an agent fills it: say why), REASSURE
 * (empty is the good outcome). A failed read is none of these.
 */
export const LENS_EMPTY_ANSWERS = [
  "omit",
  "invite",
  "explain",
  "reassure",
] as const;
export type LensEmptyAnswer = (typeof LENS_EMPTY_ANSWERS)[number];

/**
 * At-rest caps (skill §6). Produced is a horizontal row of peers, so it takes
 * more; Proposed is a quiet lane, so it takes fewest; Happened is today's
 * batched lines.
 */
export const LENS_CAPS = {
  blocking: 5,
  happening: 5,
  produced: 8,
  proposed: 3,
  happened: 10,
} as const satisfies Record<AttentionClass, number>;

/**
 * The empty answers a `lens-section` block may be GIVEN (the catalog's
 * `empty` prop): the four minus INVITE. INVITE needs an action the reader
 * takes (ui-composition §2), and a block in a document has none to offer, so
 * the clients drew it as EXPLAIN anyway. A stored `invite` reads as `explain`
 * ({@link readLensSectionEmpty}).
 */
export const LENS_SECTION_EMPTY_ANSWERS = [
  "omit",
  "explain",
  "reassure",
] as const satisfies readonly LensEmptyAnswer[];
export type LensSectionEmptyAnswer =
  (typeof LENS_SECTION_EMPTY_ANSWERS)[number];

/**
 * The answer of a section drawn ALONE (a `lens-section` block) with no
 * `empty` prop: the lens page's own under a block, where no header says "all
 * clear" for it. An empty Needs you REASSURES ("All clear"); every other class
 * OMITS. The one source for the web block and the phone.
 */
export function lensSectionDefaultEmpty(
  section: AttentionClass
): LensSectionEmptyAnswer {
  void section;
  return "omit";
}

/**
 * A stored or sent `empty` prop read back as a block's answer, or null when it
 * names none. A legacy `invite` (offered until the catalog narrowed it) reads
 * as `explain`, the way both clients drew it.
 */
export function readLensSectionEmpty(
  value: unknown
): LensSectionEmptyAnswer | null {
  return typeof value === "string" &&
    (LENS_SECTION_EMPTY_ANSWERS as readonly string[]).includes(value)
    ? (value as LensSectionEmptyAnswer)
    : null;
}
