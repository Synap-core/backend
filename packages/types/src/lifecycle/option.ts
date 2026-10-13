/**
 * The lifecycle OPTION model: categories, an option, and its words and tone.
 *
 * A leaf module so `./steps.ts` can read it without importing `./index.ts`,
 * which re-exports `./steps.ts` — that cycle left `STEP_POSITIONS` in its
 * temporal dead zone when a dev bundle (React Refresh) read the exports of
 * `./index.ts` mid-load, and relay web would not boot. Re-exported unchanged
 * from `./index.ts`; import it from `@synap-core/types/lifecycle`.
 */
import type { UnitTone } from "../units/state.js";
import { resolveStatusLabel } from "../vocabulary/index.js";

export const LIFECYCLE_CATEGORIES = [
  "open",
  "active",
  "paused",
  "done",
  "lost",
] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];

export interface LifecycleOption {
  key: string;
  /** Authored label. Absent ⇒ the vocabulary (`resolveStatusLabel`). */
  label?: string;
  category: LifecycleCategory;
  /** A `UnitTone` token. Absent ⇒ {@link LIFECYCLE_CATEGORY_TONE}. */
  tone?: string;
  humanOnly?: boolean;
  /**
   * Days in this option before a thing is STUCK. Absent ⇒ no stuck rule (a
   * surface omits its Stuck count). Never on a done/lost option.
   */
  stuckAfterDays?: number;
}

/** The default mark of each category — a tone TOKEN, never a colour. */
export const LIFECYCLE_CATEGORY_TONE: Readonly<
  Record<LifecycleCategory, UnitTone>
> = {
  open: "textSecondary",
  active: "primary",
  paused: "warning",
  done: "success",
  lost: "error",
};

const UNIT_TONES: readonly string[] = [
  "primary",
  "ai",
  "info",
  "error",
  "success",
  "warning",
  "textSecondary",
  "textMuted",
] satisfies readonly UnitTone[];

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
  return option.tone && UNIT_TONES.includes(option.tone)
    ? (option.tone as UnitTone)
    : LIFECYCLE_CATEGORY_TONE[option.category];
}
