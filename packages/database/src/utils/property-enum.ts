/**
 * THE ONE MAPPER between the enum AUTHORING spelling and the enum STORED TRUTH.
 *
 * ── The two spellings, and which one is real ────────────────────────────────
 * A closed set of admissible values for a property has been written two ways:
 *
 *   `uiHints.enumValues`   — the AUTHORING spelling. It is what a workspace
 *                            template YAML writes (`enumValues: [...]`), and
 *                            what the template DSL calls the field.
 *   `constraints.enum`     — the STORED TRUTH. It is what readers must read.
 *
 * `constraints.enum` is canonical because a closed set is a VALIDATION RULE,
 * not a presentation hint. It is enforceable by the importer, MCP and the CLI
 * with no UI in the loop, and `PropertyUIHints` (schema/property-defs.ts:21)
 * does not even declare an `enumValues` key — a value written there is outside
 * the column's own declared type.
 *
 * ── Why this file exists (measured, 2026-09-06) ─────────────────────────────
 * The reconciler wrote the AUTHORING spelling straight into the database, so a
 * template-installed enum property was BORN with its options on a key nothing
 * reads. It had not drifted; it was never right.
 *
 *   364 authored enum properties across 30 workspace-template YAMLs
 *   0    of them author `constraints.enum`
 *
 * That is not only a rendering bug. `property-validation-service.ts` guards on
 * `if (constraints.enum && Array.isArray(constraints.enum))` — so for all 364
 * the check did not FAIL, it did not RUN, and any string was accepted
 * server-side. `capture.ts` reads the same key, so AI capture could not see the
 * admissible values either.
 *
 * It stayed invisible because `ensure-system-profiles.ts` writes
 * `constraints.enum` correctly at 27 sites: every BUILT-IN picker worked and
 * only TEMPLATE-INSTALLED ones were text boxes. The two populations never
 * appeared in the same screenshot.
 *
 * ── The rule this file enforces ─────────────────────────────────────────────
 * `enumValues` is an AUTHORING spelling; `constraints.enum` is the STORED
 * TRUTH; exactly ONE function maps between them, and it is in this file.
 * Do not add a reader-side adapter elsewhere — `resolvePropertyLabel` is the
 * cautionary precedent: it fixed the same class for `label`/`displayName` by
 * adapting on READ, and the result was a hand-copied second implementation for
 * React Native plus a surface still reading the raw key today.
 *
 * ⚠️ An earlier version of this comment claimed fixing the writer needed ZERO
 * reader changes "because every reader is already correct". That was FALSE and
 * a review caught it: `apps/crm/lib/dynamicDetails.tsx` read the legacy key
 * FIRST and the canonical one only as a fallback — the exact inverse. It needed
 * one reader fix, and the claim is not worth repeating: verify precedence, do
 * not assume it.
 */

/**
 * An option OBJECT — the richer spelling of one enum value (0319, work model
 * L1). Stored at `constraints.enumOptions`; `constraints.enum` (the bare key
 * list every reader and the validator use) is DERIVED from it here and nowhere
 * else, so the two can never disagree. `category` is what makes a select a
 * lifecycle (`utils/lifecycle-model.ts`); a plain select may carry labels only.
 */
export interface StoredEnumOption {
  key: string;
  label?: string;
  category?: string;
  tone?: string;
  humanOnly?: boolean;
  /** Days in this option before a thing is stuck (`utils/lifecycle-model.ts`). */
  stuckAfterDays?: number;
}

/** The authoring shape a template property arrives in. */
export interface TemplateEnumSource {
  /** The AUTHORING spelling — what template YAML writes. */
  enumValues?: unknown;
  /** Option OBJECTS (`{ key, label?, category?, tone?, humanOnly? }`). Wins over `enumValues`. */
  enumOptions?: unknown;
  /** Any constraints the template authored directly (may already carry `enum`). */
  constraints?: Record<string, unknown> | null;
}

/** A stored property def, as read back from the database. */
export interface StoredEnumSource {
  constraints?: Record<string, unknown> | null;
  uiHints?: Record<string, unknown> | null;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

/**
 * Normalise option objects (or bare strings) into `StoredEnumOption[]`.
 * Lenient on SHAPE (a bare string becomes `{ key }`), strict on IDENTITY (an
 * entry with no key is dropped, a duplicate key keeps the first). Returns
 * `undefined` for anything that is not a non-empty array of options.
 * Category VALIDITY is the lifecycle declaration's job, not this mapper's.
 */
export function normalizeEnumOptions(
  value: unknown
): StoredEnumOption[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: StoredEnumOption[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const raw =
      typeof item === "string"
        ? { key: item }
        : item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : null;
    const key = typeof raw?.key === "string" ? raw.key.trim() : "";
    if (!raw || !key || seen.has(key)) continue;
    seen.add(key);
    const opt: StoredEnumOption = { key };
    if (typeof raw.label === "string" && raw.label.trim())
      opt.label = raw.label.trim();
    if (typeof raw.category === "string" && raw.category.trim())
      opt.category = raw.category.trim();
    if (typeof raw.tone === "string" && raw.tone.trim())
      opt.tone = raw.tone.trim();
    if (raw.humanOnly === true) opt.humanOnly = true;
    // Kept when it is a positive whole number; its VALIDITY for the option's
    // category is the lifecycle declaration's job, like the category's.
    if (
      typeof raw.stuckAfterDays === "number" &&
      Number.isInteger(raw.stuckAfterDays) &&
      raw.stuckAfterDays > 0
    )
      opt.stuckAfterDays = raw.stuckAfterDays;
    out.push(opt);
  }
  return out.length ? out : undefined;
}

/**
 * Build the `constraints` object to STORE for a template-authored property.
 *
 * Folds the authoring spelling into `constraints.enum` while preserving every
 * constraint the template authored directly. An `enum` the template authored
 * explicitly WINS over the `enumValues` shorthand — the explicit, canonical
 * spelling is never overwritten by the convenience one.
 */
export function buildStoredConstraints(
  prop: TemplateEnumSource,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  const authored = { ...(prop.constraints ?? {}), ...(extra ?? {}) };
  // Option OBJECTS win: the key list is DERIVED from them, so `enum` and
  // `enumOptions` are written together, here, and can never disagree.
  const options = normalizeEnumOptions(
    prop.enumOptions ?? authored.enumOptions
  );
  if (options) {
    return {
      ...authored,
      enumOptions: options,
      enum: options.map((o) => o.key),
    };
  }
  if (authored.enum !== undefined) return authored;

  const fromShorthand = asStringArray(prop.enumValues);
  return fromShorthand ? { ...authored, enum: fromShorthand } : authored;
}

/**
 * Read the enum options actually stored on a property def.
 *
 * Reads the canonical key, then falls back to the legacy authoring key.
 *
 * ⚠️ The fallback is TRANSITIONAL and deliberately scoped to the reconciler's
 * own drift comparison. Rows written before migration 0247 still carry their
 * options on `uiHints.enumValues`; without this the very first reconcile after
 * the fix would read `undefined`, treat the template list as new, and report a
 * change on every property in every pod. This is NOT a general reader adapter
 * and must not be imported by presentation code — presentation reads
 * `constraints.enum` directly, and the two source-scan tripwires exist to keep
 * it that way.
 */
export function readStoredEnum(def: StoredEnumSource): string[] | undefined {
  return (
    asStringArray(def.constraints?.enum) ??
    asStringArray(def.uiHints?.enumValues)
  );
}

/**
 * Read the enum OPTIONS stored on a property def: the option objects when the
 * def carries them, else the bare key list lifted to `{ key }`. `undefined`
 * for a property with no closed set. Same transitional fallback as
 * {@link readStoredEnum}.
 */
export function readStoredEnumOptions(
  def: StoredEnumSource
): StoredEnumOption[] | undefined {
  return (
    normalizeEnumOptions(def.constraints?.enumOptions) ??
    readStoredEnum(def)?.map((key) => ({ key }))
  );
}
