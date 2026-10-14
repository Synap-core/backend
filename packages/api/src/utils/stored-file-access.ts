/**
 * Who may SIGN a stored blob — the read floor of the file door
 * (`GET /api/files/documents/:id/url`, `GET /api/files/:entityId/url`).
 *
 * A blob is readable when:
 *   1. its `documents` row is readable (`loadReadableDocument` — the registered
 *      `documents` VisibilityRule: owner, workspace member, exposure, a
 *      pod-shared entity's body, a readable view's canvas); or
 *   2. an entity the caller can READ (the registered `entities` rule) points at
 *      it — as its own file (`entities.document_id`) or as a pod-held media
 *      copy (`systemData.media[].documentId`). Without this leg a pod-wide
 *      entity's cover/avatar 403s for every member but its author, although
 *      the entity itself is readable to them.
 *
 * The OWNER LOCK on leg 2: the referencing entity's owner must own the
 * document. `entities.document_id` and `systemData.media` are both reachable
 * from writers, so without it anyone could point an entity they own at another
 * user's document and have this door sign it. Every legitimate writer (the
 * upload door, the media copy) stores the document under the entity's owner.
 */
import { TRPCError } from "@trpc/server";
import {
  and,
  eq,
  inArray,
  isNull,
  or,
  drizzleSql,
  db,
  documents,
  entities,
} from "@synap/database";
import { AccessContext, scopedDb } from "../access/index.js";
import { loadReadableDocument } from "./document-edit-access.js";

export interface SignableDocument {
  id: string;
  storageKey: string | null;
}

/**
 * The document when `userId` may read its blob, else `undefined` (the route
 * tells unknown from forbidden). Never swallows a failed read: only the read
 * floor's NOT_FOUND means "not readable".
 */
export async function loadSignableDocument(
  userId: string,
  documentId: string
): Promise<SignableDocument | undefined> {
  try {
    const doc = await loadReadableDocument(userId, documentId);
    return { id: doc.id, storageKey: doc.storageKey ?? null };
  } catch (err) {
    if (!(err instanceof TRPCError && err.code === "NOT_FOUND")) throw err;
  }

  const ownerOfDocument = db
    .select({ userId: documents.userId })
    .from(documents)
    .where(eq(documents.id, documentId));
  const referencing = await scopedDb(AccessContext.operator({ userId }))
    .findFirst<{ id: string }>(entities, {
      columns: { id: true },
      where: and(
        isNull(entities.deletedAt),
        or(
          eq(entities.documentId, documentId),
          drizzleSql`${entities.systemData} -> 'media' @> ${JSON.stringify([
            { documentId },
          ])}::jsonb`
        ),
        inArray(entities.userId, ownerOfDocument)
      ),
    });
  if (!referencing) return undefined;

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
    columns: { id: true, storageKey: true },
  });
  return doc ? { id: doc.id, storageKey: doc.storageKey ?? null } : undefined;
}

export interface SignableFileEntity {
  id: string;
  /** The blob key: the linked document's, else the legacy property. */
  storageKey: string | undefined;
}

/**
 * A file entity the caller can READ (the registered `entities` rule), with the
 * storage key of the document it links — under the same owner lock: the
 * document must belong to the ENTITY's owner (not merely be linked).
 */
export async function loadSignableFileEntity(
  userId: string,
  entityId: string
): Promise<SignableFileEntity | undefined> {
  const entity = await scopedDb(AccessContext.operator({ userId })).findFirst<{
    id: string;
    userId: string;
    documentId: string | null;
    properties: unknown;
  }>(entities, {
    columns: { id: true, userId: true, documentId: true, properties: true },
    where: eq(entities.id, entityId),
  });
  if (!entity) return undefined;

  let storageKey: string | undefined;
  if (entity.documentId) {
    const doc = await db.query.documents.findFirst({
      where: and(
        eq(documents.id, entity.documentId),
        eq(documents.userId, entity.userId)
      ),
      columns: { storageKey: true },
    });
    storageKey = doc?.storageKey ?? undefined;
  }
  if (!storageKey) {
    // Early `file` entities kept the key on the entity, not a documents row.
    const props = (entity.properties ?? {}) as Record<string, unknown>;
    if (typeof props.storageKey === "string") storageKey = props.storageKey;
  }
  return { id: entity.id, storageKey };
}
