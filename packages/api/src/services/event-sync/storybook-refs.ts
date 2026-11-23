/**
 * The records a storybook sync names by id (its app, its brand identity),
 * read through the caller's entity read floor. A sync never links a record its
 * owner cannot read, and never creates one it names.
 */
import { and, db, entities, eq, isNull } from "@synap/database";
import { isUuid } from "@synap-core/types/property-render";
import { entityReadVisibleWhere } from "../../access/entity-read-floor.js";

/** The id when `userId` can read a live `kind` record with this id; null otherwise. */
export async function readableEntityOfKind(
  userId: string,
  id: string,
  kind: string
): Promise<string | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.id, id),
        eq(entities.type, kind),
        isNull(entities.deletedAt),
        entityReadVisibleWhere(userId)
      )
    )
    .limit(1);
  return row?.id ?? null;
}
