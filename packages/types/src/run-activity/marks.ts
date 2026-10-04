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
import type { StepPhase } from "./derive.js";

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
