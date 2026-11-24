/**
 * The records a storybook sync names by id (its app, its brand identity),
 * read through the caller's entity read floor. A sync never links a record its
 * owner cannot read, and never creates one it names.
 */
import {
  and,
  db,
  entities,
  eq,
  isNull,
  profileSlugScopeCondition,
} from "@synap/database";
import { isUuid } from "@synap-core/types/property-render";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";

/**
 * The id when `userId` can read a live record of `kind` (its kind, or a role
 * it wears) with this id; null otherwise.
 */
export async function readableEntityOfKind(
  userId: string,
  id: string,
  kind: string
): Promise<string | null> {
  if (!isUuid(id)) return null;
  // Identity-wide: the id names one record, whichever space holds it; the
  // read floor below still decides whether this user may see it.
  const ofKind = await profileSlugScopeCondition(
    db,
    kind,
    await resolveFacetVisibilityScope(userId, undefined)
  );
  const [row] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.id, id),
        ofKind,
        isNull(entities.deletedAt),
        entityReadVisibleWhere(userId)
      )
    )
    .limit(1);
  return row?.id ?? null;
}
