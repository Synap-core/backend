/**
 * The ONE steps model — what a step strip draws (wave 2, L3/L8).
 *
 * A strip is a row of steps, each at a POSITION on a path. Two sources feed
 * it today and both adapt to the same `StepMark`:
 *
 *   - a lifecycle (`stepsFromLifecycle`) — a kind's or a role's declared
 *     statuses, with the thing's current one;
 *   - a track's stages (`stepsFromTrackStages`) — kept until L7 retires
 *     track stages (wave 5).
 *
 * The position → tone rule lives HERE only ({@link stepTone}). A renderer maps
 * the tone token to its own fill (web `toneVars`, relay `useToneFill`) and
 * never re-declares a position → tone or position → glyph table.
 */
import type { UnitTone } from "../units/state.js";
import type { TrackStage } from "../units/track.js";
import {
  lifecycleOptionLabel,
  lifecycleOptionTone,
  type LifecycleCategory,
  type LifecycleOption,
} from "./index.js";

/**
 * Where a step stands on the path.
 *
 *   - `passed`  — on the main path, before the current step;
 *   - `current` — the step the thing stands on;
 *   - `ahead`   — on the main path, after the current step (or every main
 *                 step when the thing stands off the path);
 *   - `off`     — an off-path step (a paused or lost status) the thing stands
 *                 on NOW. Off-path steps are drawn only when current.
 */
export const STEP_POSITIONS = ["passed", "current", "ahead", "off"] as const;
export type StepPosition = (typeof STEP_POSITIONS)[number];

export interface StepMark {
  /** The lifecycle option key, or the track stage key. A move targets it. */
  key: string;
  label: string;
  position: StepPosition;
  /** A tone TOKEN ({@link stepTone}) — a FILL, never text ink, never a colour. */
  tone: UnitTone;
  /** How many things / sessions sit at this step, when the caller counted. */
  count?: number;
  /** The lifecycle category of a lifecycle step; absent on a track stage. */
  category?: LifecycleCategory;
  /** Only a person may move a thing INTO this step (the person glyph). */
  humanOnly?: boolean;
}

/**
 * The tone of a step. Current and off wear the step's own tone (the option's,
 * or the accent for a track stage). Passed is `textSecondary`, NOT `success`:
 * a lost deal must not show a row of green checks before its red mark.
 */
export function stepTone(position: StepPosition, ownTone: UnitTone): UnitTone {
  switch (position) {
    case "current":
    case "off":
      return ownTone;
    case "passed":
      return "textSecondary";
    case "ahead":
      return "textMuted";
  }
}

/** Categories on the main path; the rest (paused, lost) are off-path. */
const MAIN_PATH_CATEGORIES: readonly LifecycleCategory[] = [
  "open",
  "active",
  "done",
];

/**
 * A lifecycle as steps, for a thing whose status is `currentKey`.
 *
 *   - The main path is the open / active / done options in DECLARED order:
 *     `passed` before the current option, `ahead` after it.
 *   - A paused or lost option is drawn only when it is current, as `off`; the
 *     main path is then all `ahead` (where it left the path is not known
 *     from the status alone — history is a separate read).
 *   - A `currentKey` outside the declaration (or null) marks nothing current:
 *     every main step is `ahead`. The strip never invents a position.
 *
 * `counts` (optional) carries a per-option count onto each step.
 */
export function stepsFromLifecycle(
  decl: { readonly options: readonly LifecycleOption[] } | null | undefined,
  currentKey: string | null | undefined,
  counts?: Readonly<Record<string, number>>
): StepMark[] {
  if (!decl) return [];
  const main = decl.options.filter((o) =>
    MAIN_PATH_CATEGORIES.includes(o.category)
  );
  const currentIndex = main.findIndex((o) => o.key === currentKey);
  const steps: StepMark[] = [];
  for (const option of decl.options) {
    const onMain = MAIN_PATH_CATEGORIES.includes(option.category);
    let position: StepPosition;
    if (onMain) {
      const i = main.indexOf(option);
      position =
        currentIndex < 0
          ? "ahead"
          : i < currentIndex
            ? "passed"
            : i === currentIndex
              ? "current"
              : "ahead";
    } else if (option.key === currentKey) {
      position = "off";
    } else {
      continue;
    }
    const mark: StepMark = {
      key: option.key,
      label: lifecycleOptionLabel(option),
      position,
      tone: stepTone(position, lifecycleOptionTone(option)),
      category: option.category,
    };
    if (option.humanOnly) mark.humanOnly = true;
    const n = counts?.[option.key];
    if (typeof n === "number") mark.count = n;
    steps.push(mark);
  }
  return steps;
}

const TRACK_POSITION: Readonly<Record<TrackStage["position"], StepPosition>> = {
  done: "passed",
  active: "current",
  not_started: "ahead",
};

/**
 * A track's stages as steps (done → passed, active → current, not_started →
 * ahead). POSITION is the pod's (`deriveTrackStages`), never re-derived. The
 * current stage wears the one accent; `sessionCount` becomes `count`.
 */
export function stepsFromTrackStages(
  stages: readonly TrackStage[]
): StepMark[] {
  return stages.map((stage) => {
    const position = TRACK_POSITION[stage.position];
    const mark: StepMark = {
      key: stage.key,
      label: stage.name,
      position,
      tone: stepTone(position, "primary"),
    };
    if (typeof stage.sessionCount === "number") mark.count = stage.sessionCount;
    return mark;
  });
}

/** The step the thing stands on (`current` or `off`), or null. */
export function currentStep(steps: readonly StepMark[]): StepMark | null {
  return (
    steps.find((s) => s.position === "current" || s.position === "off") ?? null
  );
}
