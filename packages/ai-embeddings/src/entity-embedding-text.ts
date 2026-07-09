/**
 * Canonical builder for the text that represents an entity in the semantic
 * embedding (entity_vectors).
 *
 * WHY THIS EXISTS — retrieval-quality fix (2026-06-12): embeddings were built
 * from `title + preview` ONLY. The entity TYPE and typed PROPERTIES (e.g.
 * role="VP Product", status, dueDate) were never embedded, so semantic recall
 * could not match type-intent queries ("what did we decide" → decision) or
 * property queries ("who is the VP of Product" → the person with role=VP
 * Product). Dogfood: such queries retrieved the right entity only at rank 4–10
 * and MISSED at the top-K an AI actually uses. Including type + curated
 * properties here makes them rank-1.
 *
 * Keep this the SINGLE source of truth — every site that embeds an entity must
 * call it, so the embed text never drifts between the worker, the inline path,
 * and the backfill script.
 */
/** A live facet attached to the entity — kept minimal so callers don't need the full EffectiveFacet shape. */
export interface EntityEmbeddingFacet {
  /** Role-profile slug (e.g. "client", "speaker"). */
  slug: string;
  status?: string | null;
  properties?: Record<string, unknown> | null;
}

/** Format `{key: value}` pairs the same way for both entity properties and facet properties. */
function formatPropertyEntries(properties: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith("_")) continue; // internal markers (_dogfood, _pendingStructure…)
    if (/(^id$|Id$|_id$)/.test(key)) continue; // foreign-key ids = noise, not meaning
    if (value === null || value === undefined || value === "") continue;

    let val: string;
    if (typeof value === "string") val = value;
    else if (typeof value === "number" || typeof value === "boolean")
      val = String(value);
    else continue; // skip nested objects/arrays — keep the embed text clean

    val = val.trim();
    if (!val || val.length > 240) continue; // long blobs live in `preview`/content
    out.push(`${key}: ${val}`);
  }
  return out;
}

export function buildEntityEmbeddingText(input: {
  type?: string | null;
  title?: string | null;
  preview?: string | null;
  properties?: Record<string, unknown> | null;
  /** Live facets (Kind+Facets) — role-profiles attached to the entity. */
  facets?: EntityEmbeddingFacet[] | null;
}): string {
  const parts: string[] = [];
  // Type first so type-intent queries ("decision", "task", "person") match.
  if (input.type) parts.push(input.type);
  if (input.title) parts.push(input.title);
  if (input.preview) parts.push(input.preview);

  if (input.properties) {
    parts.push(...formatPropertyEntries(input.properties));
  }

  if (input.facets && input.facets.length > 0) {
    // Compact: "client (active; tier: gold), partner" — facet slug plus a
    // parenthesized status/properties summary when present.
    const facetParts = input.facets.map((facet) => {
      const details: string[] = [];
      if (facet.status) details.push(facet.status);
      if (facet.properties)
        details.push(...formatPropertyEntries(facet.properties));
      return details.length > 0
        ? `${facet.slug} (${details.join("; ")})`
        : facet.slug;
    });
    parts.push(`roles: ${facetParts.join(", ")}`);
  }

  return parts.join(" · ").trim();
}
