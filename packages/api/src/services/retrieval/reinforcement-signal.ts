/**
 * Reinforcement retrieval signal (Horizon) — how often the user has actually
 * returned to an entity.
 *
 * `user_entity_state` tracks per-user interaction counters (Phase 1 now
 * populates `view_count` on entity views). We batch-read the counts for the
 * candidate pool in ONE `inArray` query, keyed `(userId, itemId, 'entity')`.
 * The pure log-compression + normalization happens in the ranker
 * (`horizon-rerank.ts`); this module is the single DB read.
 */
import { db, userEntityState, and, eq, inArray } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger: any = createLogger({ module: "retrieval" });

/**
 * viewCount per entity id from `user_entity_state`. Ids with no state row are
 * simply absent from the map (the ranker treats a miss as 0). One batched query.
 *
 * Never throws: if the read fails (missing table or any DB error) we log at
 * debug and return an EMPTY map, so Horizon degrades gracefully (reinforcement
 * contributes nothing) rather than breaking retrieval.
 */
export async function viewCountsByEntity(
  entityIds: string[],
  userId: string
): Promise<Map<string, number>> {
  if (entityIds.length === 0) return new Map();
  try {
    const rows = await db
      .select({
        itemId: userEntityState.itemId,
        viewCount: userEntityState.viewCount,
      })
      .from(userEntityState)
      .where(
        and(
          eq(userEntityState.userId, userId),
          eq(userEntityState.itemType, "entity"),
          inArray(userEntityState.itemId, entityIds)
        )
      );
    return new Map(rows.map((r) => [r.itemId, r.viewCount ?? 0]));
  } catch (err) {
    logger.debug({ err }, "reinforcement read failed — degrading to empty");
    return new Map();
  }
}
