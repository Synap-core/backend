/**
 * THE LIFECYCLE MODEL (work model L1/L2, W12–W14) — pure, no I/O.
 *
 * Every kind and every role declares at most ONE lifecycle: one select
 * property (the link row `profile_properties.is_lifecycle`) whose options are
 * objects `{ key, label?, category, tone?, humanOnly? }` stored at
 * `property_defs.constraints.enumOptions` (the bare `constraints.enum` key list
 * is DERIVED from them by the one mapper, `utils/property-enum.ts`).
 *
 * Categories are FIXED: `open · active · paused · done · lost`. Everything
 * that must reason about "where does this stand" — terminal state, goals,
 * governance, hand-off — reads the CATEGORY, never an option name.
 *
 * This file is the pod's copy of the model. `@synap-core/types/lifecycle`
 * (which the frontends import) holds the same category list and option shape,
 * pinned EQUAL at compile time by `types/src/lifecycle/pod-parity.contract.ts`
 * — this package cannot import `@synap-core/types` (types builds against it).
 */

export const LIFECYCLE_CATEGORIES = [
  "open",
  "active",
  "paused",
  "done",
  "lost",
] as const;
export type LifecycleCategory = (typeof LIFECYCLE_CATEGORIES)[number];

/** Categories that END the thing's journey. An agent entering one proposes (W14). */
export const TERMINAL_LIFECYCLE_CATEGORIES: readonly LifecycleCategory[] = [
  "done",
  "lost",
];

export interface LifecycleOption {
  /** The stored value (what `entities.status` / `properties[slug]` hold). */
  key: string;
  /** Authored label. Absent ⇒ the vocabulary's `resolveStatusLabel(key)`. */
  label?: string;
  category: LifecycleCategory;
  /** A `UnitTone` token. Absent ⇒ the category's default tone. */
  tone?: string;
  /** Only a person may move a thing INTO this option (no rule can widen it). */
  humanOnly?: boolean;
}

export interface LifecycleDeclaration {
  /** The lifecycle property's slug — the key of the read projection. */
  propertySlug: string;
  options: LifecycleOption[];
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
