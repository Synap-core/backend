/**
 * THE LIFECYCLE MODEL (work model L1/L2, W12–W14) — pure, no I/O.
 *
 * Every kind and every role declares at most ONE lifecycle: one select
 * property (the link row `profile_properties.is_lifecycle`) whose options are
 * objects `{ key, label?, category, tone?, humanOnly?, stuckAfterDays?,
 * dateBinding? }` stored at
 * `property_defs.constraints.enumOptions` (the bare `constraints.enum` key list
 * is DERIVED from them by the one mapper, `utils/property-enum.ts`).
 *
 * Categories are FIXED: `open · active · paused · done · lost`. Everything
 * that must reason about "where does this stand" — terminal state, goals,
 * governance, hand-off — reads the CATEGORY, never an option name.
 *
 * The category list, the option shape and the declaration are
 * `@synap-core/types/lifecycle`'s (which the frontends import), re-exported
 * here: ONE declaration. This file
 * adds the pod's side of the model — declarations, validation, moves.
 */

import {
  LIFECYCLE_CATEGORIES,
  TERMINAL_LIFECYCLE_CATEGORIES,
  type LifecycleCategory,
  type LifecycleDeclaration,
  type LifecycleOption,
} from "@synap-core/types/lifecycle";
import { foldPropertyKey } from "../services/did-you-mean.js";

export {
  LIFECYCLE_CATEGORIES,
  TERMINAL_LIFECYCLE_CATEGORIES,
  type LifecycleCategory,
  type LifecycleDeclaration,
  type LifecycleOption,
};

/**
 * A profile's lifecycle as RESOLVED for use (`getEffectiveLifecycle`): the
 * declaration plus where it came from. `unclassified` lists stored option keys
 * that carry no valid category — they stay admissible values of the select,
 * but no move may target them and nothing guesses what they mean.
 */
export interface EffectiveLifecycle extends LifecycleDeclaration {
  propertyDefId: string;
  /** The profile whose link declares it (the leaf, or an ancestor). */
  declaredOnProfileId: string;
  unclassified: string[];
}

/** The longest stuck threshold an option may declare (ten years). */
export const STUCK_AFTER_DAYS_MAX = 3650;

/** A valid `dateBinding`: a property slug (letters, digits, `_`, `-`). */
const DATE_BINDING = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** A valid `stuckAfterDays`: a whole number of days, 1…{@link STUCK_AFTER_DAYS_MAX}. */
export function isStuckAfterDays(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 1 &&
    v <= STUCK_AFTER_DAYS_MAX
  );
}

export function isLifecycleCategory(v: unknown): v is LifecycleCategory {
  return (
    typeof v === "string" &&
    (LIFECYCLE_CATEGORIES as readonly string[]).includes(v)
  );
}

/**
 * Parse authored/stored option objects. Every problem is reported — a
 * lifecycle with a missing or unknown category is refused, never guessed.
 */
export function parseLifecycleOptions(raw: unknown): {
  options: LifecycleOption[];
  errors: string[];
} {
  const errors: string[] = [];
  const options: LifecycleOption[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return { options, errors: ["a lifecycle needs at least one option"] };
  }
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") {
      errors.push(`option ${i} is not an object`);
      return;
    }
    const o = item as Record<string, unknown>;
    const key = typeof o.key === "string" ? o.key.trim() : "";
    if (!key) {
      errors.push(`option ${i} has no key`);
      return;
    }
    if (seen.has(key)) {
      errors.push(`option "${key}" is declared twice`);
      return;
    }
    seen.add(key);
    if (!isLifecycleCategory(o.category)) {
      errors.push(
        `option "${key}" needs a category (one of ${LIFECYCLE_CATEGORIES.join(", ")})`
      );
      return;
    }
    const opt: LifecycleOption = { key, category: o.category };
    if (typeof o.label === "string" && o.label.trim())
      opt.label = o.label.trim();
    if (typeof o.tone === "string" && o.tone.trim()) opt.tone = o.tone.trim();
    if (o.humanOnly === true) opt.humanOnly = true;
    if (o.stuckAfterDays !== undefined) {
      // A bad threshold is reported (an authoring door refuses it) but never
      // drops the option: a stored lifecycle still reads every column.
      if (!isStuckAfterDays(o.stuckAfterDays)) {
        errors.push(
          `option "${key}" stuckAfterDays must be a whole number of days from 1 to ${STUCK_AFTER_DAYS_MAX}`
        );
      } else if (TERMINAL_LIFECYCLE_CATEGORIES.includes(o.category)) {
        errors.push(
          `option "${key}" is ${o.category}: a finished thing cannot be stuck (stuckAfterDays is for open, active or paused options)`
        );
      } else {
        opt.stuckAfterDays = o.stuckAfterDays;
      }
    }
    if (o.dateBinding !== undefined) {
      // Validated like `stuckAfterDays`: reported, never dropping the option.
      if (
        typeof o.dateBinding !== "string" ||
        !DATE_BINDING.test(o.dateBinding)
      ) {
        errors.push(
          `option "${key}" dateBinding must name a date property (its slug, e.g. "dueDate")`
        );
      } else if (TERMINAL_LIFECYCLE_CATEGORIES.includes(o.category)) {
        errors.push(
          `option "${key}" is ${o.category}: a finished thing cannot be late (dateBinding is for open, active or paused options)`
        );
      } else {
        opt.dateBinding = o.dateBinding;
      }
    }
    options.push(opt);
  });
  return { options, errors };
}

export function findLifecycleOption(
  decl: Pick<LifecycleDeclaration, "options">,
  key: string | null | undefined
): LifecycleOption | undefined {
  if (key == null) return undefined;
  return decl.options.find((o) => o.key === key);
}

/**
 * The declared option a caller MEANT: the exact key, else the ONE option that
 * differs from `key` only by case or `-`/`_`/space (`in_progress` →
 * `in-progress`, `Done` → `done`) — the same fold property keys use
 * (`foldPropertyKey`). Two options folding together is ambiguous: `key` comes
 * back unchanged and the door refuses it, naming the options. Read by the
 * status door's input normaliser (`moveStatus`) only; storage stays exact.
 */
export function canonicalLifecycleOptionKey(
  decl: Pick<LifecycleDeclaration, "options">,
  key: string
): string {
  if (findLifecycleOption(decl, key)) return key;
  const folded = foldPropertyKey(key);
  const matches = decl.options.filter((o) => foldPropertyKey(o.key) === folded);
  return matches.length === 1 ? matches[0].key : key;
}

/**
 * What a move INTO `to` means for governance. `null` when `to` is not an
 * option of the lifecycle (the door refuses such a move before it gets here).
 */
export function classifyLifecycleMove(
  decl: Pick<LifecycleDeclaration, "options">,
  to: string
): {
  toCategory: LifecycleCategory;
  intoTerminal: boolean;
  humanOnly: boolean;
} | null {
  const opt = findLifecycleOption(decl, to);
  if (!opt) return null;
  return {
    toCategory: opt.category,
    intoTerminal: TERMINAL_LIFECYCLE_CATEGORIES.includes(opt.category),
    humanOnly: opt.humanOnly === true,
  };
}
