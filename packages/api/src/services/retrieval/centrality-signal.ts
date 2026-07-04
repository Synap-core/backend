/**
 * Centrality retrieval signal (Horizon Phase 3) — global PageRank per entity.
 *
 * The `entity_centrality` side table holds a batch-computed global PageRank score
 * per entity (written by the `pagerank-centrality` pg-boss job). We batch-read
 * the scores for the candidate pool in ONE `inArray` query (mirrors
 * reinforcement-signal.ts). The pure normalization to [0,1] over the pool happens
 * in the ranker (`horizon-rerank.ts`); this module is the single DB read.
 *
 * Graceful fallback: if the job has never run (no rows), this returns an EMPTY
 * map and the caller keeps its existing propagation-weight proxy for `C`, so
 * Horizon never errors on a pod that hasn't computed centrality yet.
 */
import { db, entityCentrality, and, eq, inArray } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger: any = createLogger({ module: "retrieval" });

/**
 * PageRank score per entity id from `entity_centrality`, gated by userId
 * (defense-in-depth; the pool ids are already user-scoped upstream). Ids with no
 * row are simply absent from the map (the ranker treats a miss as 0). Empty pool
 * ⇒ empty map. One batched query.
 *
 * Never throws: if the read fails (e.g. the `entity_centrality` table is missing
 * because the Phase-3 migration hasn't applied on this pod, or any DB error) we
 * log at debug and return an EMPTY map. The caller then keeps its propagation
 * proxy for `C`, so Horizon degrades gracefully instead of breaking retrieval.
 */
export async function centralityByEntity(
  entityIds: string[],
  userId: string
): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();
  try {
    const rows = await db
      .select({
        entityId: entityCentrality.entityId,
        score: entityCentrality.score,
      })
      .from(entityCentrality)
      .where(
        and(
          eq(entityCentrality.userId, userId),
          inArray(entityCentrality.entityId, entityIds)
        )
      );
    return new Map(rows.map((r) => [r.entityId, r.score ?? 0]));
  } catch (err) {
    logger.debug(
      { err },
      "centrality read failed — degrading to empty (entity_centrality missing?)"
    );
    return new Map();
  }
}
