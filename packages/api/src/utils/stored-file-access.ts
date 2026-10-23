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
 * document. `entities.document_id`, `systemData.media` and a declared media
 * property are all reachable from writers, so without it anyone could point an
 * entity they own at another user's document and have this door sign it.
 * Every legitimate writer (the upload door, the media copy) stores the
 * document under the entity's owner.
 *
 * The ENTITY HINT on leg 2: a caller that knows which entity it is drawing
 * passes its id (`?entityId=`), and the door checks that ONE row — including
 * the media property its kind DECLARES (`uiHints.presentation.media`, e.g. a
 * brand asset's `asset-document-id`), which no reverse lookup can find. Without
 * a hint the door falls back to a reverse lookup over `entities.document_id`
 * (indexed) and `systemData.media` (not indexed — a scan; callers should pass
 * the hint).
 */
import { TRPCError } from "@trpc/server";
import {
  and,
  eq,
  isNull,
  or,
  drizzleSql,
  db,
  documents,
  entities,
  profiles,
} from "@synap/database";
import {
  declaredMediaSources,
  presentationFromUiHints,
  readEntityMediaCopies,
} from "@synap-core/types/presentation";
import { AccessContext, scopedDb } from "../access/index.js";
import { loadReadableDocument } from "./document-edit-access.js";

export interface SignableDocument {
  id: string;
  storageKey: string | null;
  /** The type the blob was stored (and is served) with; null when unknown. */
  mimeType: string | null;
}

/**
 * The document when `userId` may read its blob, else `undefined` (the route
 * tells unknown from forbidden). Never swallows a failed read: only the read
 * floor's NOT_FOUND means "not readable".
 */
export async function loadSignableDocument(
  userId: string,
  documentId: string,
  opts: { viaEntityId?: string } = {}
): Promise<SignableDocument | undefined> {
  try {
    const doc = await loadReadableDocument(userId, documentId);
    return {
      id: doc.id,
      storageKey: doc.storageKey ?? null,
      mimeType: doc.mimeType ?? null,
    };
  } catch (err) {
    if (!(err instanceof TRPCError && err.code === "NOT_FOUND")) throw err;
  }

  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
    columns: { id: true, userId: true, storageKey: true, mimeType: true },
  });
  if (!doc) return undefined;
  const signable: SignableDocument = {
    id: doc.id,
    storageKey: doc.storageKey ?? null,
    mimeType: doc.mimeType ?? null,
  };

  if (opts.viaEntityId) {
    return (await hintedEntityHoldsDocument(userId, opts.viaEntityId, doc))
      ? signable
      : undefined;
  }

  const referencing = await scopedDb(
    AccessContext.operator({ userId })
  ).findFirst<{ id: string }>(entities, {
    columns: { id: true },
    where: and(
      isNull(entities.deletedAt),
      eq(entities.userId, doc.userId),
      or(
        eq(entities.documentId, documentId),
        drizzleSql`${entities.systemData} -> 'media' @> ${JSON.stringify([
          { documentId },
        ])}::jsonb`
      )
    ),
  });
  return referencing ? signable : undefined;
}

/**
 * The hinted entity is readable to `userId`, owned by the document's owner,
 * and holds the document: as its own file, as a pod-held media copy, or in a
 * media property its kind declares.
 */
async function hintedEntityHoldsDocument(
  userId: string,
  entityId: string,
  doc: { id: string; userId: string }
): Promise<boolean> {
  const entity = await scopedDb(AccessContext.operator({ userId })).findFirst<{
    id: string;
    userId: string;
    profileId: string | null;
    documentId: string | null;
    properties: unknown;
    systemData: unknown;
  }>(entities, {
    columns: {
      id: true,
      userId: true,
      profileId: true,
      documentId: true,
      properties: true,
      systemData: true,
    },
    where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
  });
  if (!entity || entity.userId !== doc.userId) return false;
  if (entity.documentId === doc.id) return true;
  if (
    readEntityMediaCopies(entity.systemData).some(
      (m) => m.documentId === doc.id
    )
  )
    return true;
  if (!entity.profileId) return false;
  const profile = await db.query.profiles.findFirst({
    where: eq(profiles.id, entity.profileId),
    columns: { uiHints: true },
  });
  const props = (entity.properties ?? {}) as Record<string, unknown>;
  return declaredMediaSources(presentationFromUiHints(profile?.uiHints)).some(
    (src) => "property" in src && props[src.property] === doc.id
  );
}

export interface SignableFileEntity {
  id: string;
  /**
   * The linked document — only when it belongs to the ENTITY's owner (the
   * owner lock below); undefined otherwise.
   */
  documentId: string | undefined;
  /** The blob key of the linked document; undefined when there is none. */
  storageKey: string | undefined;
  /** The served type — only ever the `documents` row's, never a property's claim. */
  mimeType: string | null;
}

/**
 * A file entity the caller can READ (the registered `entities` rule), with the
 * storage key of the document it links — under the same owner lock: the
 * document must belong to the ENTITY's owner (not merely be linked).
 *
 * Only a `documents` row names a signable key. A key written into the entity's
 * own properties (`properties.storageKey`, the shape of the earliest `file`
 * entities) is never signed: properties are writable by anyone who may edit
 * the entity, so a co-editor could aim it at any key — even under the owner's
 * own storage namespace, where the owner's private document snapshots live.
 */
export async function loadSignableFileEntity(
  userId: string,
  entityId: string
): Promise<SignableFileEntity | undefined> {
  const entity = await scopedDb(AccessContext.operator({ userId })).findFirst<{
    id: string;
    userId: string;
    documentId: string | null;
  }>(entities, {
    columns: { id: true, userId: true, documentId: true },
    where: eq(entities.id, entityId),
  });
  if (!entity) return undefined;

  const doc = entity.documentId
    ? await db.query.documents.findFirst({
        where: and(
          eq(documents.id, entity.documentId),
          eq(documents.userId, entity.userId)
        ),
        columns: { id: true, storageKey: true, mimeType: true },
      })
    : undefined;
  return {
    id: entity.id,
    documentId: doc?.id ?? undefined,
    storageKey: doc?.storageKey ?? undefined,
    mimeType: doc?.mimeType ?? null,
  };
}
