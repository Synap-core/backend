/**
 * Knowledge kind contract
 *
 * `knowledge` is a primary kind. Its form is a mutually-exclusive property,
 * not an attached role: roles/facets are deliberately additive everywhere else
 * in Synap. Keep the legacy `ek_type` value when normalising so existing data
 * remains auditable while the decision/reference rows are reviewed.
 *
 * Knowledge is something still true and useful in three months (founder
 * decision, plan 9992207a §5): a `fact` (how something works), a `caution` (a
 * pitfall and how to avoid it) or a `convention` (how we do things here). The
 * routing rule that keeps everything else out of it is taught by the system
 * skill `skills/synap/writing-titles.md`.
 */

export const KNOWLEDGE_FORMS = ["fact", "caution", "convention"] as const;

export type KnowledgeForm = (typeof KNOWLEDGE_FORMS)[number];

/**
 * Retired `knowledgeForm` VALUES and the form they now mean. `insight` was the
 * broad form before the 2026-10-12 narrowing; migration 0326 rewrites stored
 * rows, and this alias keeps an old client (or a row the migration has not
 * reached) valid: it is read and written as `fact`, never rejected.
 */
export const LEGACY_KNOWLEDGE_FORM_ALIASES: Readonly<
  Record<string, KnowledgeForm>
> = {
  insight: "fact",
};

/** The property that carries the full knowledge sentence (required). */
export const KNOWLEDGE_CLAIM_SLUG = "ek_claim";

export const LEGACY_KNOWLEDGE_TYPES = [
  "gotcha",
  "lesson",
  "decision",
  "reference",
] as const;

export type LegacyKnowledgeType = (typeof LEGACY_KNOWLEDGE_TYPES)[number];

/** A write payload cannot claim two different Knowledge classifications. */
export class KnowledgeFormConflictError extends Error {
  constructor(
    public readonly knowledgeForm: KnowledgeForm,
    public readonly legacyType: LegacyKnowledgeType
  ) {
    super(
      `knowledgeForm '${knowledgeForm}' conflicts with legacy ek_type '${legacyType}'`
    );
    this.name = "KnowledgeFormConflictError";
  }
}

/**
 * Compatibility mapping for historic captures/imports.
 *
 * The old value is intentionally retained in `ek_type`. In particular,
 * `decision` and `reference` are not materialised as new graph entities here:
 * they receive the broad `fact` form only so a legacy record stays valid
 * under the new exactly-one form contract. A later reviewed migration can turn
 * those records into linked Decision/Source entities without having lost the
 * original discriminator.
 */
export const LEGACY_KNOWLEDGE_FORM_MAP: Record<
  LegacyKnowledgeType,
  KnowledgeForm
> = {
  gotcha: "caution",
  lesson: "fact",
  decision: "fact",
  reference: "fact",
};

export function isKnowledgeForm(value: unknown): value is KnowledgeForm {
  return (
    typeof value === "string" &&
    (KNOWLEDGE_FORMS as readonly string[]).includes(value)
  );
}

export function isLegacyKnowledgeType(
  value: unknown
): value is LegacyKnowledgeType {
  return (
    typeof value === "string" &&
    (LEGACY_KNOWLEDGE_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Add the canonical form for a legacy payload without deleting or rewriting
 * any legacy property. An explicitly supplied invalid form is deliberately
 * left untouched so normal property validation can reject it instead of this
 * compatibility layer masking a client error.
 */
export function normalizeKnowledgeProperties(
  input: Record<string, unknown>
): Record<string, unknown> {
  // A retired form value (`insight`) is rewritten to its canonical form first,
  // so it is accepted and then checked like any explicit form.
  const aliased =
    typeof input.knowledgeForm === "string" &&
    Object.prototype.hasOwnProperty.call(
      LEGACY_KNOWLEDGE_FORM_ALIASES,
      input.knowledgeForm
    )
      ? LEGACY_KNOWLEDGE_FORM_ALIASES[input.knowledgeForm]
      : undefined;
  const properties = aliased ? { ...input, knowledgeForm: aliased } : input;
  const legacyType = properties.ek_type;
  const explicitForm = properties.knowledgeForm;
  // Let the property validator report an invalid explicit form. A recognized
  // legacy value, however, may never disagree with a valid canonical form.
  if (isKnowledgeForm(explicitForm)) {
    if (
      isLegacyKnowledgeType(legacyType) &&
      LEGACY_KNOWLEDGE_FORM_MAP[legacyType] !== explicitForm
    ) {
      throw new KnowledgeFormConflictError(explicitForm, legacyType);
    }
    return { ...properties };
  }
  if ("knowledgeForm" in properties) return { ...properties };

  if (!isLegacyKnowledgeType(legacyType)) return { ...properties };

  return {
    ...properties,
    knowledgeForm: LEGACY_KNOWLEDGE_FORM_MAP[legacyType],
  };
}

/**
 * Read-only projection for historic rows. Unlike the write normalizer, this
 * never throws: a previously persisted mismatch must remain readable and is
 * surfaced unchanged for later review rather than making GET/list fail.
 */
export function projectKnowledgeProperties(
  properties: Record<string, unknown>
): Record<string, unknown> {
  try {
    return normalizeKnowledgeProperties(properties);
  } catch (error) {
    if (error instanceof KnowledgeFormConflictError) return { ...properties };
    throw error;
  }
}

/**
 * Conservative fallback for capture classifications that identify Knowledge
 * but omit its form. Warnings/failure language is a caution; all other
 * knowledge defaults to fact. This only chooses a form for NEW capture
 * material and never changes an existing entity.
 */
export function inferKnowledgeForm(text: string): KnowledgeForm {
  const haystack = text.toLowerCase();
  if (
    /\b(gotcha|caution|warning|warn|pitfall|failure|fails?|avoid|cannot)\b/.test(
      haystack
    )
  ) {
    return "caution";
  }
  return "fact";
}

/** True when the properties already carry a non-blank claim. */
export function hasKnowledgeClaim(
  properties: Record<string, unknown>
): boolean {
  const claim = properties[KNOWLEDGE_CLAIM_SLUG];
  return typeof claim === "string" && claim.trim().length > 0;
}

/**
 * The claim a door derives when its caller supplied none: the first non-blank
 * line of the first non-blank candidate, in the order the door passes them.
 * Doors pass the TITLE first — a knowledge title is "the claim as a short
 * sentence" (writing-titles rubric) — then the body. Never truncated: a claim
 * cut off reads as a different claim.
 */
export function deriveKnowledgeClaim(
  candidates: ReadonlyArray<unknown>
): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const line = candidate
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (line) return line;
  }
  return undefined;
}

/**
 * Fill the required `ek_claim` at a door that cannot ask its caller for one
 * (capture, structuring, import, approval of an older proposal, an update of a
 * historic row). A supplied claim is never touched; with no usable candidate
 * the claim stays absent so validation reports it instead of a blank.
 */
export function completeKnowledgeClaim(
  properties: Record<string, unknown>,
  candidates: ReadonlyArray<unknown>
): Record<string, unknown> {
  if (hasKnowledgeClaim(properties)) return { ...properties };
  const claim = deriveKnowledgeClaim(candidates);
  if (!claim) return { ...properties };
  return { ...properties, [KNOWLEDGE_CLAIM_SLUG]: claim };
}

/**
 * Complete a historic Knowledge write before schema validation.
 *
 * Older proposals can predate both `knowledgeForm` and the legacy `ek_type`
 * discriminator. Keep a recognized legacy value authoritative; otherwise use
 * the same conservative text inference as capture. The required claim is
 * derived from `claimFrom` (title first, then body) when absent. This is a
 * write-time compatibility door, never a migration of an existing entity.
 */
export function completeKnowledgeProperties(
  properties: Record<string, unknown>,
  text: string,
  claimFrom: ReadonlyArray<unknown> = [text]
): Record<string, unknown> {
  const normalized = normalizeKnowledgeProperties(properties);
  if (!("knowledgeForm" in normalized)) {
    normalized.knowledgeForm = inferKnowledgeForm(text);
  }
  return completeKnowledgeClaim(normalized, claimFrom);
}
