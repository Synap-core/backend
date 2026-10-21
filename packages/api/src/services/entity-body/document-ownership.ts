/**
 * Is this document already OWNED by another object — the body of another live
 * entity, or a view's canvas? The ONE ownership question behind every body
 * link: the attach door (`assertDocumentAttachable`) refuses such a document,
 * and an Undo that would re-attach a previous body (`safe-revert`
 * `entity_body`) skips when it is now owned elsewhere. A document follows its
 * entity on the read floors, so a document owned twice is shown to two
 * audiences and edited through both.
 */
import { and, eq, isNull, ne, type db as Database } from "@synap/database";
import { entities, views } from "@synap/database/schema";

type OwnershipReader = Pick<typeof Database, "select">;

export async function documentOwnedByAnotherObject(
  reader: OwnershipReader,
  documentId: string,
  entityId: string
): Promise<boolean> {
  const [otherEntity] = await reader
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.documentId, documentId),
        ne(entities.id, entityId),
        isNull(entities.deletedAt)
      )
    )
    .limit(1);
  if (otherEntity) return true;
  const [owningView] = await reader
    .select({ id: views.id })
    .from(views)
    .where(eq(views.documentId, documentId))
    .limit(1);
  return Boolean(owningView);
}
