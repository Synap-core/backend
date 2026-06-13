/**
 * Hybrid recall — the lexical+semantic floor of the Synap Retrieval Engine.
 *
 * pgvector (cosine over type+property-enriched embeddings) + Typesense (BM25),
 * merged via Reciprocal Rank Fusion (k=60). Optionally scoped to a single
 * profileSlug on BOTH halves. Extracted as one source of truth so the retrieval
 * engine and the legacy POST /entities/recall share identical mechanics instead
 * of drifting copies.
 */

import { db, entityVectors, eq, and, drizzleSql } from "@synap/database";
import { searchService } from "@synap/search";
import { createLogger } from "@synap-core/core";
import { getDefaultActiveService } from "../../utils/intelligence-routing.js";

// Degradation is graceful but not invisible: the `source` flag signals a
// vector-skip at the API boundary, and these debug logs let a pod operator see
// WHY a half dropped. Kept at debug (not error) — a missing half is recoverable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const logger: any = createLogger({ module: "retrieval" });

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
  limit: number;
  /**
   * Precomputed query embedding. Pass it to reuse one embedding across several
   * fused passes (avoids N IS round-trips). `undefined` → embed here; `null` →
   * skip the vector half (Typesense-only).
   */
  embedding?: number[] | null;
}

export interface HybridRecallResult {
  ids: string[];
  usedVector: boolean;
}

export async function hybridRecall(
  params: HybridRecallParams
): Promise<HybridRecallResult> {
  const { query, userId, workspaceId, profileSlug, limit } = params;
  const widen = limit * 2;

  // ── pgvector (semantic) ─────────────────────────────────────────────────
  let vectorIds: string[] = [];
  let usedVector = false;
  const embedding =
    params.embedding !== undefined ? params.embedding : await embedQuery(query);
  if (embedding) {
    try {
      const vecLiteral = `[${embedding.join(",")}]`;
      const where = profileSlug
        ? and(
            drizzleSql`${entityVectors.userId} = ${userId}`,
            eq(entityVectors.entityType, profileSlug)
          )
        : drizzleSql`${entityVectors.userId} = ${userId}`;
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
    if (profileSlug) {
      hits = hits.filter((r) => {
        const d = r.document as Record<string, unknown>;
        return d.entityType === profileSlug || d.type === profileSlug;
      });
    }
    keywordIds = hits
      .map((r) => (r.document as Record<string, unknown>).id as string)
      .filter(Boolean);
  } catch (err) {
    logger.debug({ err }, "Typesense recall failed");
  }

  return { ids: rrf([vectorIds, keywordIds], 60, limit), usedVector };
}
