/**
 * THE LIFECYCLE MODEL (work model L1/L2, W12–W14) — pure, no I/O.
 *
 * Every kind and every role declares at most ONE lifecycle: one select
 * property (the link row `profile_properties.is_lifecycle`) whose options are
 * objects `{ key, label?, category, tone?, humanOnly?, stuckAfterDays?,
 * dateBinding?, waits?, requires? }` stored at
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
  HOLD_ON,
  LIFECYCLE_CATEGORIES,
  LIFECYCLE_REQUIREMENT_DIRECTIONS,
  LIFECYCLE_REQUIREMENT_OWNERS,
  TERMINAL_LIFECYCLE_CATEGORIES,
  type HoldOn,
  type LifecycleCategory,
  type LifecycleDeclaration,
  type LifecycleOption,
  type LifecycleOptionRequirement,
  type LifecycleOptionWaits,
} from "@synap-core/types/lifecycle";
import { isWaitKind } from "@synap-core/types/units";
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
  /**
   * The status a new thing or role starts in when its creator names none:
   * the declaring link's `profile_properties.default_value`, the column the
   * lifecycle door `setLifecycleInitialStatus` writes. `null` = none set (a
   * stored default that is not a string is reported as none, never guessed).
   */
  initialStatus: string | null;
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
    if (o.waits !== undefined) {
      // Validated like `dateBinding`: reported, never dropping the option.
      const parsed = parseOptionWaits(key, o.category, o.waits);
      if (typeof parsed === "string") errors.push(parsed);
      else opt.waits = parsed;
    }
    if (o.requires !== undefined) {
      // Validated like `waits`: reported, never dropping the option.
      const parsed = parseOptionRequires(key, o.category, o.requires);
      if (typeof parsed === "string") errors.push(parsed);
      else if (parsed.length > 0) opt.requires = parsed;
    }
    options.push(opt);
  });
  return { options, errors };
}

/**
 * What a step may say it waits on: a hold's own `on` (`HOLD_ON`, no new list;
 * never `unspecified`, which says nothing), the finer `waitKind`
 * (`WAIT_KINDS`), the property naming who (`refFrom`) and the date that ends
 * it (`dateBinding`). The one parser, so the def door and the lifecycle door
 * cannot disagree. Returns the clean shape, or the error words.
 */
export function parseOptionWaits(
  key: string,
  category: LifecycleCategory,
  raw: unknown
): LifecycleOptionWaits | string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `option "${key}" waits must be an object { on, waitKind?, refFrom?, dateBinding? }`;
  }
  if (TERMINAL_LIFECYCLE_CATEGORIES.includes(category)) {
    return `option "${key}" is ${category}: a finished thing waits on nothing (waits is for open, active or paused options)`;
  }
  const w = raw as Record<string, unknown>;
  const on = w.on;
  if (
    typeof on !== "string" ||
    on === "unspecified" ||
    !(HOLD_ON as readonly string[]).includes(on)
  ) {
    return `option "${key}" waits.on must be one of ${HOLD_ON.filter((h) => h !== "unspecified").join(" | ")}`;
  }
  const out: LifecycleOptionWaits = { on: on as HoldOn };
  if (w.waitKind !== undefined) {
    if (!isWaitKind(w.waitKind)) {
      return `option "${key}" waits.waitKind is not a wait kind (WAIT_KINDS)`;
    }
    out.waitKind = w.waitKind;
  }
  for (const field of ["refFrom", "dateBinding"] as const) {
    const v = w[field];
    if (v === undefined) continue;
    if (typeof v !== "string" || !DATE_BINDING.test(v)) {
      return `option "${key}" waits.${field} must name a property (its slug, e.g. "${field === "refFrom" ? "contactId" : "nextActionAt"}")`;
    }
    out[field] = v;
  }
  const unknown = Object.keys(w).filter(
    (k) => !["on", "waitKind", "refFrom", "dateBinding"].includes(k)
  );
  if (unknown.length > 0) {
    return `option "${key}" waits has unknown field(s): ${unknown.join(", ")}`;
  }
  return out;
}

/** Most requirements one option may declare. */
export const REQUIREMENTS_PER_OPTION_MAX = 10;

/** A `blockerKey`: lowercase letters, digits and `_` (`no_contact`). */
const BLOCKER_KEY = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * What a step may REQUIRE of a thing standing in it (`LifecycleOption.requires`):
 * a closed, typed list — `link` (a relation type, a direction, a minimum
 * count) or `property` (present, or one of `in`), each with its
 * `blockerKey`, `label?`, `clearedBy?`, `owner?` (`you` | `agent`) and
 * `forKinds?`. No expression language. The one parser, so every door that
 * declares a lifecycle (the def door, the lifecycle door, a catalog install)
 * reads it alike. Returns the clean list, or the error words.
 *
 * Names are checked for SHAPE only: a role's requirement may name a property
 * of the kind wearing it (a lead's person: `linkedinUrl`), which is not the
 * role's own property, and a relation type may be a workspace's own slug.
 */
export function parseOptionRequires(
  key: string,
  category: LifecycleCategory,
  raw: unknown
): LifecycleOptionRequirement[] | string {
  const at = (i: number) => `option "${key}" requires[${i}]`;
  if (!Array.isArray(raw)) {
    return `option "${key}" requires must be a list of { kind: "link" | "property", blockerKey, ... }`;
  }
  if (raw.length > 0 && TERMINAL_LIFECYCLE_CATEGORIES.includes(category)) {
    return `option "${key}" is ${category}: a finished thing requires nothing (requires is for open, active or paused options)`;
  }
  if (raw.length > REQUIREMENTS_PER_OPTION_MAX) {
    return `option "${key}" requires at most ${REQUIREMENTS_PER_OPTION_MAX} things`;
  }
  const out: LifecycleOptionRequirement[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return `${at(i)} must be an object`;
    }
    const r = item as Record<string, unknown>;
    if (typeof r.blockerKey !== "string" || !BLOCKER_KEY.test(r.blockerKey)) {
      return `${at(i)}.blockerKey must be a lowercase name (letters, digits, _), e.g. "no_contact"`;
    }
    if (seen.has(r.blockerKey)) {
      return `${at(i)}.blockerKey "${r.blockerKey}" is declared twice`;
    }
    seen.add(r.blockerKey);
    const base: {
      blockerKey: string;
      label?: string;
      owner?: LifecycleOptionRequirement["owner"];
      clearedBy?: LifecycleOptionRequirement["clearedBy"];
      forKinds?: string[];
    } = { blockerKey: r.blockerKey };
    if (r.label !== undefined) {
      if (typeof r.label !== "string" || !r.label.trim()) {
        return `${at(i)}.label must be words`;
      }
      base.label = r.label.trim();
    }
    if (r.owner !== undefined) {
      if (
        !(LIFECYCLE_REQUIREMENT_OWNERS as readonly unknown[]).includes(r.owner)
      ) {
        return `${at(i)}.owner must be one of ${LIFECYCLE_REQUIREMENT_OWNERS.join(" | ")}`;
      }
      base.owner = r.owner as LifecycleOptionRequirement["owner"];
    }
    if (r.clearedBy !== undefined) {
      const c = parseRequirementClearedBy(r.clearedBy);
      if (!c) {
        return `${at(i)}.clearedBy must be one of { answer: true } | { intent } | { playbookId } | { capability }`;
      }
      base.clearedBy = c;
    }
    if (r.forKinds !== undefined) {
      if (
        !Array.isArray(r.forKinds) ||
        r.forKinds.length === 0 ||
        !r.forKinds.every((k) => typeof k === "string" && DATE_BINDING.test(k))
      ) {
        return `${at(i)}.forKinds must be a list of kind slugs (e.g. ["person"])`;
      }
      base.forKinds = [...new Set(r.forKinds as string[])];
    }
    const common = [
      "kind",
      "blockerKey",
      "label",
      "owner",
      "clearedBy",
      "forKinds",
    ];
    if (r.kind === "link") {
      if (typeof r.relation !== "string" || !DATE_BINDING.test(r.relation)) {
        return `${at(i)}.relation must name a relation type (its slug, e.g. "works_at")`;
      }
      if (
        !(LIFECYCLE_REQUIREMENT_DIRECTIONS as readonly unknown[]).includes(
          r.direction
        )
      ) {
        return `${at(i)}.direction must be "out" (the thing is the link's source) or "in" (its target)`;
      }
      if (
        r.min !== undefined &&
        !(
          typeof r.min === "number" &&
          Number.isInteger(r.min) &&
          r.min >= 1 &&
          r.min <= 1000
        )
      ) {
        return `${at(i)}.min must be a whole number from 1 to 1000`;
      }
      const unknown = Object.keys(r).filter(
        (k) => ![...common, "relation", "direction", "min"].includes(k)
      );
      if (unknown.length > 0) {
        return `${at(i)} has unknown field(s): ${unknown.join(", ")}`;
      }
      out.push({
        ...base,
        kind: "link",
        relation: r.relation,
        direction: r.direction as "out" | "in",
        ...(typeof r.min === "number" ? { min: r.min } : {}),
      });
      continue;
    }
    if (r.kind === "property") {
      if (typeof r.property !== "string" || !DATE_BINDING.test(r.property)) {
        return `${at(i)}.property must name a property (its slug, e.g. "linkedinUrl")`;
      }
      if (
        r.in !== undefined &&
        !(
          Array.isArray(r.in) &&
          r.in.length > 0 &&
          r.in.every((v) => typeof v === "string" && v.trim())
        )
      ) {
        return `${at(i)}.in must be a non-empty list of values`;
      }
      const unknown = Object.keys(r).filter(
        (k) => ![...common, "property", "in"].includes(k)
      );
      if (unknown.length > 0) {
        return `${at(i)} has unknown field(s): ${unknown.join(", ")}`;
      }
      out.push({
        ...base,
        kind: "property",
        property: r.property,
        ...(Array.isArray(r.in) ? { in: [...new Set(r.in as string[])] } : {}),
      });
      continue;
    }
    return `${at(i)}.kind must be "link" or "property"`;
  }
  return out;
}

/** The one shape of what clears a blocker (`ThingBlockerClearedBy`); null when it is none. */
function parseRequirementClearedBy(
  raw: unknown
): LifecycleOptionRequirement["clearedBy"] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const keys = Object.keys(c);
  if (keys.length !== 1) return null;
  if (c.answer === true) return { answer: true };
  for (const k of ["intent", "playbookId", "capability"] as const) {
    const v = c[k];
    if (typeof v === "string" && v.trim()) {
      return { [k]: v.trim() } as LifecycleOptionRequirement["clearedBy"];
    }
  }
  return null;
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
