/**
 * Knowledge kind contract
 *
 * `knowledge` is a primary kind. Its form is a mutually-exclusive property,
 * not an attached role: roles/facets are deliberately additive everywhere else
 * in Synap. Keep the legacy `ek_type` value when normalising so existing data
 * remains auditable while the decision/reference rows are reviewed.
 */

export const KNOWLEDGE_FORMS = ["insight", "caution"] as const;

export type KnowledgeForm = (typeof KNOWLEDGE_FORMS)[number];

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
 * they receive the broad `insight` form only so a legacy record stays valid
 * under the new exactly-one form contract. A later reviewed migration can turn
 * those records into linked Decision/Source entities without having lost the
 * original discriminator.
 */
export const LEGACY_KNOWLEDGE_FORM_MAP: Record<
  LegacyKnowledgeType,
  KnowledgeForm
> = {
  gotcha: "caution",
  lesson: "insight",
  decision: "insight",
  reference: "insight",
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
  properties: Record<string, unknown>
): Record<string, unknown> {
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
 * knowledge defaults to insight. This only chooses a form for NEW capture
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
  return "insight";
}
