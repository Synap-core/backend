/**
 * Hybrid recall — the lexical+semantic floor of the Synap Retrieval Engine.
 *
 * pgvector (cosine over type+property-enriched embeddings) + Typesense (BM25),
 * merged via Reciprocal Rank Fusion (k=60). Optionally scoped to a single
 * profileSlug on BOTH halves. Extracted as one source of truth so the retrieval
 * engine and the legacy POST /entities/recall share identical mechanics instead
 * of drifting copies.
 */

import {
  db,
  entityVectors,
  eq,
  and,
  inArray,
  drizzleSql,
  resolveSlugKind,
  loadFacetSlugsBatch,
  type FacetVisibilityScope,
} from "@synap/database";
import { searchService } from "@synap/search";
import { createLogger } from "@synap-core/core";
import { getDefaultActiveService } from "../../utils/intelligence-routing.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";

// Degradation is graceful but not invisible: the `source` flag signals a
// vector-skip at the API boundary, and these debug logs let a pod operator see
// WHY a half dropped. Kept at debug (not error) — a missing half is recoverable.

const logger: any = createLogger({ module: "retrieval" });

/**
 * Conservative floor on pgvector cosine similarity. pgvector's `<=>` operator
 * (vector_cosine_ops) returns cosine DISTANCE = 1 - cosine_similarity, so a
 * candidate is kept only when `distance <= 1 - MIN_VECTOR_SIMILARITY`. Applied
 * IN the nearest-neighbour query (not post-filtered) so genuinely-unrelated
 * rows never occupy a `widen` slot ahead of real hits. 0.25 was chosen to trim
 * the long tail of near-orthogonal embeddings (the noise floor for our
 * text-embedding model) without cutting into legitimate paraphrase-level
 * matches, which typically score well above 0.4.
 */
export const MIN_VECTOR_SIMILARITY = 0.25;
export const MAX_VECTOR_DISTANCE = 1 - MIN_VECTOR_SIMILARITY;

/** Embed a query via the active Intelligence Service; null on any failure. */
export async function embedQuery(query: string): Promise<number[] | null> {
  try {
    const { endpoint, apiKey } = await getDefaultActiveService();
    const res = await fetch(`${endpoint}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ text: query }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const { embedding } = (await res.json()) as { embedding?: number[] };
    return Array.isArray(embedding) && embedding.length > 0 ? embedding : null;
  } catch (err) {
    logger.debug({ err }, "query embedding unavailable — Typesense-only");
    return null;
  }
}

/** Reciprocal Rank Fusion over N ranked id-lists. */
export function rrf(lists: string[][], k = 60, limit?: number): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
    });
  }
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  return limit ? ranked.slice(0, limit) : ranked;
}

export interface HybridRecallParams {
  query: string;
  userId: string;
  workspaceId?: string | null;
  /** Scope BOTH halves to one profile type. */
  profileSlug?: string;
  /**
   * Project focus lens — the set of entity ids belonging to the active project
   * (the project entity + its `belongs_to_project` members), precomputed once by
   * the caller. When present, BOTH recall halves are constrained to this set at
   * QUERY time (not post-filtered) so the recall budget fills with project rows
   * instead of being starved by unscoped matches. Empty set → no project rows.
   */
  projectIds?: Set<string>;
  limit: number;
  /**
   * Precomputed query embedding. Pass it to reuse one embedding across several
   * fused passes (avoids N IS round-trips). `undefined` → embed here; `null` →
   * skip the vector half (Typesense-only).
   */
  embedding?: number[] | null;
  /** Pre-resolved once by composite retrieval to avoid repeated membership reads. */
  facetVisibilityScope?: FacetVisibilityScope;
}

export interface HybridRecallResult {
  ids: string[];
  usedVector: boolean;
}

export async function hybridRecall(
  params: HybridRecallParams
): Promise<HybridRecallResult> {
  const { query, userId, workspaceId, profileSlug, projectIds, limit } = params;
  const facetVisibilityScope =
    params.facetVisibilityScope ??
    (await resolveFacetVisibilityScope(userId, workspaceId));
  // When a project lens is active, widen the recall budget so the project rows
  // aren't crowded out before the in-query filter applies (esp. the Typesense
  // half, which filters its hit list rather than constraining the index query).
  const widen = projectIds ? limit * 6 : limit * 2;
  // Empty project set = nothing belongs to the project → no rows, short-circuit.
  if (projectIds && projectIds.size === 0)
    return { ids: [], usedVector: false };

  // Kind+Facets: an entity wearing a ROLE keeps its KIND `entityType` (a
  // `company` faceted `client` is still entityType=company). So scoping either
  // recall half by `entityType === roleSlug` silently misses every facet-wearer
  // — the structural bypass. Resolve the slug once (cached): a ROLE slug matches
  // FACET MEMBERSHIP, so we widen both halves (drop the entityType constraint)
  // and post-filter the union to facet-wearers via ONE batched facet load. A
  // pure KIND (or unknown) slug keeps the byte-for-byte entityType constraint.
  // A slug is kind XOR role after conversion (convertToFacet flips the row in
  // place, no twin), so there is no mixed set to reconcile; the unscoped recall
  // pass in retrieve.ts covers any theoretical edge.
  const slugKind = profileSlug ? await resolveSlugKind(db, profileSlug) : null;
  const matchByFacet = slugKind?.hasRoleRow ?? false;
  const scopeByEntityType = profileSlug != null && !matchByFacet;

  // ── pgvector (semantic) ─────────────────────────────────────────────────
  let vectorIds: string[] = [];
  let usedVector = false;
  const embedding =
    params.embedding !== undefined ? params.embedding : await embedQuery(query);
  if (embedding) {
    try {
      const vecLiteral = `[${embedding.join(",")}]`;
      // AND the project lens onto the vector query so the nearest-neighbour scan
      // returns project rows directly (no post-filter starvation). inArray over
      // OUR table is bounded by the project size.
      const conds = [
        drizzleSql`${entityVectors.userId} = ${userId}`,
        // Noise floor: drop candidates below MIN_VECTOR_SIMILARITY BEFORE they
        // can occupy a `widen` slot or reach fusion/slice.
        drizzleSql`${entityVectors.embedding} <=> ${vecLiteral}::vector <= ${MAX_VECTOR_DISTANCE}`,
      ];
      if (profileSlug && scopeByEntityType)
        conds.push(eq(entityVectors.entityType, profileSlug));
      if (projectIds)
        conds.push(inArray(entityVectors.entityId, [...projectIds]));
      const where = conds.length > 1 ? and(...conds) : conds[0];
      const rows = await db
        .select({ entityId: entityVectors.entityId })
        .from(entityVectors)
        .where(where)
        .orderBy(
          drizzleSql`${entityVectors.embedding} <=> ${vecLiteral}::vector`
        )
        .limit(widen);
      vectorIds = rows.map((r) => r.entityId);
      usedVector = true;
    } catch (err) {
      logger.debug({ err }, "pgvector recall failed — falling through");
    }
  }

  // ── Typesense (lexical) ─────────────────────────────────────────────────
  let keywordIds: string[] = [];
  try {
    const resp = await searchService.search({
      query,
      userId,
      workspaceId: workspaceId || undefined,
      collections: ["entities"],
      limit: widen,
      page: 1,
    });
    let hits = resp.results.filter((r) => r.collection === "entities");
    if (profileSlug && scopeByEntityType) {
      hits = hits.filter((r) => {
        const d = r.document as Record<string, unknown>;
        return d.entityType === profileSlug || d.type === profileSlug;
      });
    }
    keywordIds = hits
      .map((r) => (r.document as Record<string, unknown>).id as string)
      .filter(Boolean);
    // Project lens — Typesense has no project field, so filter the (widened)
    // hit list to the project's id set. Non-facet path truncates to `limit` (its
    // pre-facets behavior); when a facet post-filter still has to run, keep the
    // widened candidates so it isn't starved before the filter applies.
    if (projectIds) {
      keywordIds = keywordIds
        .filter((id) => projectIds.has(id))
        .slice(0, matchByFacet ? widen : limit);
    }
  } catch (err) {
    logger.debug({ err }, "Typesense recall failed");
  }

  // ── Facet post-constraint (role scope) ──────────────────────────────────
  // The slug is a ROLE: both halves were widened (entityType constraint dropped),
  // so keep only the candidates that actually WEAR the role facet. ONE batched
  // facet load over the union of both halves — the canonical entity→facet-slug
  // join (same door the search indexer uses), never a per-id lookup.
  if (matchByFacet && profileSlug) {
    const union = [...new Set([...vectorIds, ...keywordIds])];
    if (union.length > 0) {
      const slugsById = await loadFacetSlugsBatch(
        db,
        union,
        facetVisibilityScope
      );
      const wears = (id: string): boolean =>
        slugsById.get(id)?.includes(profileSlug) ?? false;
      vectorIds = vectorIds.filter(wears);
      keywordIds = keywordIds.filter(wears);
      // T3b: the facet-widening path is subtle (both halves drop the entityType
      // constraint, then post-filter to role-wearers) — log its shape so a
      // "role recall returned nothing" report can tell an empty union from an
      // over-aggressive post-filter.
      logger.debug(
        {
          slug: profileSlug,
          unionSize: union.length,
          survivors: vectorIds.length + keywordIds.length,
        },
        "hybrid-recall facet-widening post-filter applied"
      );
    } else {
      vectorIds = [];
      keywordIds = [];
    }
  }

  return { ids: rrf([vectorIds, keywordIds], 60, limit), usedVector };
}
