/**
 * The lifecycle OPTION model: categories, an option, and its words and tone.
 * The tone itself comes from THE tone table (`../units/state.ts`).
 *
 * A leaf module so `./steps.ts` can read it without importing `./index.ts`,
 * which re-exports `./steps.ts` — that cycle left `STEP_POSITIONS` in its
 * temporal dead zone when a dev bundle (React Refresh) read the exports of
 * `./index.ts` mid-load, and relay web would not boot. Re-exported unchanged
 * from `./index.ts`; import it from `@synap-core/types/lifecycle`.
 */
import {
  isUnitTone,
  LIFECYCLE_CATEGORY_TONE,
  type UnitTone,
} from "../units/state.js";
import { resolveStatusLabel } from "../vocabulary/index.js";
import type { WaitKind } from "../units/wait-kind.js";
import type { HoldOn } from "./hold.js";

export const LIFECYCLE_CATEGORIES = [
  "open",
  "active",
  "paused",
  "done",
  "lost",
] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];

export interface LifecycleOption {
  /** The stored value (what `entities.status` / `properties[slug]` hold). */
  key: string;
  /** Authored label. Absent ⇒ the vocabulary (`resolveStatusLabel`). */
  label?: string;
  category: LifecycleCategory;
  /** A `UnitTone` token. Absent ⇒ {@link LIFECYCLE_CATEGORY_TONE}. */
  tone?: string;
  /** Only a person may move a thing INTO this option (no rule can widen it). */
  humanOnly?: boolean;
  /**
   * Days in this option before a thing is STUCK. Absent ⇒ no stuck rule (a
   * surface omits its Stuck count). Never on a done/lost option.
   */
  stuckAfterDays?: number;
  /**
   * The date property this step is bound to (an invoice's `dueDate` while
   * `sent`): the thing is LATE once that date passes while it stands here,
   * APPROACHING in the days before (`./signal.ts`). Calendar time. Absent ⇒ no
   * date rule. Never on a done/lost option.
   */
  dateBinding?: string;
  /**
   * The wait this step DECLARES (decision 1, c3a662b2 §12): an ACTIVE step
   * such as "sent" or "proposal sent" waits on someone without being a pause.
   * Whose move it is and lateness then come from the step itself. Absent ⇒
   * the step waits on nothing of its own. Never on a done/lost option.
   */
  waits?: LifecycleOptionWaits;
}

/**
 * A step's declared wait. `on` is a hold's own value set (`HOLD_ON`): no new
 * list. `waitKind` is the finer axis (`WAIT_KINDS`); absent, it is read off
 * `on` through the one map table (`WAIT_KIND_FROM.hold`).
 */
export interface LifecycleOptionWaits {
  on: HoldOn;
  /** The finer kind ("signature", "payment"…); absent ⇒ derived from `on`. */
  waitKind?: WaitKind;
  /**
   * The property or relation of the thing that names WHO or WHAT is waited
   * on (a deal's `contactId`), so the wait's ref is read from the row.
   */
  refFrom?: string;
  /**
   * The date property that ends the wait (a lead's `nextActionAt`): past it,
   * the wait is late. The same reading as the option's own `dateBinding`.
   */
  dateBinding?: string;
}

/** The default mark of each category: THE tone table's (`../units/state.ts`). */
export { LIFECYCLE_CATEGORY_TONE };

/** The words for an option: its authored label, else the shared vocabulary. */
export function lifecycleOptionLabel(
  option: Pick<LifecycleOption, "key" | "label">
): string {
  return option.label?.trim() || resolveStatusLabel(option.key);
}

/** The tone for an option: its authored tone (if a real token), else its category's. */
export function lifecycleOptionTone(
  option: Pick<LifecycleOption, "category" | "tone">
): UnitTone {
  return isUnitTone(option.tone)
    ? option.tone
    : LIFECYCLE_CATEGORY_TONE[option.category];
}
