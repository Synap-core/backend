/**
 * A step's MARK — tone + glyph, never a colour and never a sentence
 * (ui-composition §1). Reuses the unit-state vocabulary (`UnitTone`,
 * `UnitGlyph`) so a step and the session it belongs to are marked from one
 * palette on both surfaces.
 *
 * TOTAL over `StepPhase` (`satisfies Record<StepPhase, …>`): a new phase with
 * no mark stops the build instead of rendering unmarked.
 *
 * The AI yellow marks ONLY the live step — provenance of work happening now.
 * A failure is never yellow (the same reasoning as relay's `AIToolRunList`).
 */

import type { UnitGlyph, UnitTone } from "../units/state.js";
import type { NowLineMode, StepPhase } from "./derive.js";

export interface StepMark {
  tone: UnitTone;
  glyph: UnitGlyph;
}

const STEP_MARKS = {
  now: { tone: "ai", glyph: "spark" },
  done: { tone: "textSecondary", glyph: "check" },
  // Same mark `resolveRunUnitState('waiting_on_you')` wears: your turn.
  waiting_on_you: { tone: "primary", glyph: "person" },
  failed: { tone: "error", glyph: "alert" },
  declined: { tone: "textMuted", glyph: "dashed-circle" },
  // Nobody saw it finish — a question, not a tick.
  unsettled: { tone: "textMuted", glyph: "question" },
} as const satisfies Record<StepPhase, StepMark>;

export function stepMark(phase: StepPhase): StepMark {
  return STEP_MARKS[phase];
}

/**
 * The Now line's mark, by mode — ONE table for every surface (browser session
 * page, run-detail, relay hero), so the line is never drawn three ways.
 *   now     — the live step's mark (AI yellow: provenance of work happening).
 *   waiting — your turn, the same mark as a step waiting on you.
 *   last    — idle is a TIME, not a state: a muted clock, never a tick that
 *             claims the run is "done".
 */
const NOW_LINE_MARKS = {
  now: STEP_MARKS.now,
  waiting: STEP_MARKS.waiting_on_you,
  last: { tone: "textMuted", glyph: "clock" },
} as const satisfies Record<NowLineMode, StepMark>;

/** The glyphs a Now line can wear — a renderer's icon table is total over these. */
export type NowLineGlyph = (typeof NOW_LINE_MARKS)[NowLineMode]["glyph"];

export function nowLineMark(mode: NowLineMode): {
  tone: UnitTone;
  glyph: NowLineGlyph;
} {
  return NOW_LINE_MARKS[mode];
}
