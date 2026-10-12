/**
 * THE INTENT SURFACE header — one kind's surface ("Posts", "Leads") under the
 * shared `LensHeader` (surfaces plan W2.4). Its scope is the `pipeline` lens
 * (`LensScope`, narrowed by a space / project / track), so the header model
 * is the SAME `LensHeaderModel`, with the intent's own counts:
 *
 *   3 need you · 2 being worked · 15 in pipeline · 1 done this week
 *
 * Each count is a door (needs you → the rail's Needs you, being worked → its
 * Working now, in pipeline → the board, done → the board's done column). A
 * READ zero omits its door; an unknown count (null) keeps it, marked "–". The
 * ONE fact is the kind's goal (a stated KPI, `lensKpiFact`), never a date.
 */
import { resolveUnitState } from "../units/state.js";
import {
  LENS_UNKNOWN_COUNT,
  lensCountDoorText,
  lensNextMove,
  type LensCountDoor,
  type LensHeaderModel,
  type LensKpiFact,
} from "./header.js";
import type { LensRow } from "./rows.js";

/** An intent surface's extra count section: the kind's board. */
export type LensIntentSection = "pipeline";

/**
 * THE intent surface's section headings — one spelling for the desktop rail
 * (browser `IntentSurface`) and the phone surface (relay `/lifecycle/[profile]`).
 * A kind's surface names its live work "Working now" (the generic lens word is
 * "Happening", `LENS_SECTION_LABELS`); the header's count door says "N being
 * worked" (`lensIntentDoorText`).
 */
export const LENS_INTENT_SECTION_LABELS = {
  blocking: "Needs you",
  happening: "Working now",
  workers: "Workers",
} as const;

export interface LensIntentCounts {
  /** Needs-you signals on this kind (`signals` by profileSlug). null = read failed. */
  needsYou: number | null;
  /** Things with a LIVE session on them (`workedBy`). null = unknown. */
  beingWorked: number | null;
  /** Things still in the pipeline (`lifecycle.board.live`). */
  live: number | null;
  /** Things that entered a done option in the window (`doneWindowed`). */
  doneWindowed: number | null;
  /** The done window, in days (`lifecycle.board.window.days`). */
  windowDays: number;
}

/** "this week" for a 7-day window, else "in the last N days". */
function windowWords(days: number): string {
  return days === 7 ? "this week" : `in the last ${days} days`;
}

/** The strip's words for an intent count door. */
export function lensIntentDoorText(
  section: LensCountDoor<LensIntentSection>["section"],
  count: number | null,
  windowDays = 7
): string {
  switch (section) {
    case "blocking":
      return lensCountDoorText("blocking", count);
    case "happening":
      return `${count ?? LENS_UNKNOWN_COUNT} being worked`;
    case "pipeline":
      return `${count ?? LENS_UNKNOWN_COUNT} in pipeline`;
    case "produced":
      return `${count ?? LENS_UNKNOWN_COUNT} done ${windowWords(windowDays)}`;
  }
}

const INTENT_DOOR_LABEL: Record<
  LensCountDoor<LensIntentSection>["section"],
  string
> = {
  blocking: "Needs you",
  happening: "Being worked",
  pipeline: "Pipeline",
  produced: "Done",
};

export function lensIntentHeaderModel(input: {
  counts: LensIntentCounts;
  /** The kind's goal — the ONE fact. */
  goal?: LensKpiFact | null;
  /** The first Blocking row, else the first Happening row (see `lensNextMove`). */
  nextMove?: LensRow | null;
  lastActivityAt?: string | null;
}): LensHeaderModel<LensIntentSection> {
  const { counts } = input;
  const bySection: Record<
    LensCountDoor<LensIntentSection>["section"],
    number | null
  > = {
    blocking: counts.needsYou,
    happening: counts.beingWorked,
    pipeline: counts.live,
    produced: counts.doneWindowed,
  };
  const doors: LensCountDoor<LensIntentSection>[] = (
    ["blocking", "happening", "pipeline", "produced"] as const
  )
    .filter((section) => bySection[section] !== 0)
    .map((section) => ({
      section,
      label: INTENT_DOOR_LABEL[section],
      count: bySection[section],
      text: lensIntentDoorText(section, bySection[section], counts.windowDays),
    }));
  return {
    scopeKind: "pipeline",
    state: resolveUnitState({
      owedFromYou: counts.needsYou ?? 0,
      running: (counts.beingWorked ?? 0) > 0,
      unreadable: counts.needsYou === null,
    }),
    narrative: [],
    doors,
    nextMove: lensNextMove(input.nextMove),
    lastActivityAt: input.lastActivityAt ?? null,
    allClear: counts.needsYou === 0 && input.nextMove?.cls !== "blocking",
    fact: input.goal ?? null,
  };
}
