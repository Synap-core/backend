/**
 * The WRITE floor of a status move (`moveStatus`): the floor the update doors
 * apply, in one place, so a door that accepts a subject on READ visibility
 * (a session's subject) can never move a status its caller could not write.
 */
import { db, and, eq, isNull } from "@synap/database";
import { entities, entityFacets } from "@synap/database/schema";
import { canWriteFacet } from "../../utils/facet-write-gate.js";
import { entityWriteVisibleWhere } from "../../routers/entities/helpers.js";

/**
 * May `userId` write the thing this move targets? A ROLE's status is the
 * facet's (`canWriteFacet` — the `entities.updateFacet` gate); a KIND's is the
 * entity's (`entityWriteVisibleWhere` — the `entities.update` gate).
 */
export async function mayWriteStatusTarget(
  target: { entityId: string; facetId: string | null },
  userId: string
): Promise<boolean> {
  if (target.facetId) {
    const [facet] = await db
      .select({
        userId: entityFacets.userId,
        workspaceId: entityFacets.workspaceId,
      })
      .from(entityFacets)
      .where(eq(entityFacets.id, target.facetId))
      .limit(1);
    return Boolean(facet) && (await canWriteFacet(facet!, userId));
  }
  const [row] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.id, target.entityId),
        isNull(entities.deletedAt),
        entityWriteVisibleWhere(userId)
      )
    )
    .limit(1);
  return Boolean(row);
}
