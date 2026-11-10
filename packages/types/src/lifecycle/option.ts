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
import { WAIT_KIND_FROM, type WaitKind } from "../units/wait-kind.js";
import type { HoldOn } from "./hold.js";
// Type-only: the blocker card and a requirement name what clears them alike.
import type { ThingBlockerClearedBy } from "../units/thing-blocker.js";

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
  /**
   * What a thing standing here must HAVE before it can move on (a lead in
   * `outreach` needs a contact; an invoice `sent` needs an amount). Each
   * unmet one is DERIVED live as a blocker on the thing (the collector's
   * `requirement` source, api `requirement-sources.ts`), never stored as a
   * flag. Absent ⇒ none. Never on a done/lost option.
   */
  requires?: LifecycleOptionRequirement[];
}

/** Whose move an unmet requirement is: the person's, or an agent's. */
export const LIFECYCLE_REQUIREMENT_OWNERS = ["you", "agent"] as const;
export type LifecycleRequirementOwner =
  (typeof LIFECYCLE_REQUIREMENT_OWNERS)[number];

/** Which way a required link runs from the thing (`out` = the thing is its source). */
export const LIFECYCLE_REQUIREMENT_DIRECTIONS = ["out", "in"] as const;
export type LifecycleRequirementDirection =
  (typeof LIFECYCLE_REQUIREMENT_DIRECTIONS)[number];

interface LifecycleRequirementBase {
  /** The blocker's domain name (`no_contact`): the card's `why.blockerKey`. Unique in its option. */
  blockerKey: string;
  /** Words for what is missing ("A contact at the company"); absent ⇒ the key, humanized. */
  label?: string;
  /** What clears it (a playbook, a capability, an intent, an answer). */
  clearedBy?: ThingBlockerClearedBy;
  /** Whose move it is; absent ⇒ `you`. */
  owner?: LifecycleRequirementOwner;
  /**
   * Only things of these kinds (profile slugs) are held to it: a role worn by
   * people and companies can require a LinkedIn profile of a person only.
   * Absent ⇒ every thing standing in the option.
   */
  forKinds?: string[];
}

/**
 * One requirement, typed and closed (no expression language):
 *  - `link`: at least `min` (default 1) relations of type `relation` run
 *    `out` from the thing or `in` to it, counting only the other ends the
 *    reader may read;
 *  - `property`: the property `property` is present (not empty) on the thing
 *    (or, for a role, on the role it wears), or one of `in` when given.
 */
export type LifecycleOptionRequirement = LifecycleRequirementBase &
  (
    | {
        kind: "link";
        /** A relation type slug (`works_at`). */
        relation: string;
        direction: LifecycleRequirementDirection;
        min?: number;
      }
    | {
        kind: "property";
        /** A property slug (`linkedinUrl`, `amount`). */
        property: string;
        /** The values that satisfy it; absent ⇒ any non-empty value. */
        in?: string[];
      }
  );

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

/**
 * The wait a MOVE lands in (`TransitionBase.wait`, status-first PR-H): stamped
 * by the mover when the target step declares one (`LifecycleOption.waits`),
 * absent otherwise. A step wait is not a pause: the hold (`hold`) stays null
 * for an active step; the wait's history (`status_wait_episode`) starts here.
 */
export interface TransitionWait {
  waitKind: WaitKind;
  /** The step's `waits.on`. */
  on?: HoldOn;
  /** What `waits.refFrom` held on the thing at the move (an id, a name). */
  ref?: string;
}

/**
 * THE stamp a move carries for its target step's declared wait: the step's
 * kind, else the one map table's (`WAIT_KIND_FROM.hold`); `ref` is the value
 * of the step's `refFrom` property, when it holds a string or a number.
 */
export function transitionWaitOf(
  waits: LifecycleOptionWaits | null | undefined,
  refValue?: unknown
): TransitionWait | null {
  if (!waits) return null;
  const waitKind =
    waits.waitKind ??
    (Object.hasOwn(WAIT_KIND_FROM.hold, waits.on)
      ? WAIT_KIND_FROM.hold[waits.on]
      : WAIT_KIND_FROM.hold.unspecified);
  const ref =
    typeof refValue === "string"
      ? refValue.trim()
      : typeof refValue === "number" && Number.isFinite(refValue)
        ? String(refValue)
        : "";
  return { waitKind, on: waits.on, ...(ref ? { ref } : {}) };
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
