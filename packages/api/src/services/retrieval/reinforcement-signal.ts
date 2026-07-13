/**
 * Reinforcement retrieval signal (Horizon) — how often the user has actually
 * returned to an entity.
 *
 * `user_resource_state` tracks explicit per-user opens. We batch-read the
 * counts for the candidate pool in one query, keyed by user/resource/entity.
 * The pure log-compression + normalization happens in the ranker
 * (`horizon-rerank.ts`); this module is the single DB read.
 */
import { db, userResourceState, and, eq, inArray } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger: any = createLogger({ module: "retrieval" });

/**
 * Open count per entity id. Ids with no state row are
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
        resourceId: userResourceState.resourceId,
        openCount: userResourceState.openCount,
      })
      .from(userResourceState)
      .where(
        and(
          eq(userResourceState.userId, userId),
          eq(userResourceState.resourceType, "entity"),
          inArray(userResourceState.resourceId, entityIds)
        )
      );
    return new Map(rows.map((row) => [row.resourceId, row.openCount]));
  } catch (err) {
    logger.debug({ err }, "reinforcement read failed — degrading to empty");
    return new Map();
  }
}
