/**
 * A media copy's `documents` row is the entity's picture, held by the pod —
 * not a document anyone filed. It is marked at store time
 * (`metadata.uploadKind = "media-copy"`, `metadata.mediaCopyOf = <entityId>`)
 * and every document LIST leaves it out (Files, the mention picker). It is
 * still a real document: the file door signs it, the entity's systemData
 * names it, and its `document.create.completed` event stays — that event row
 * is the fact bus peer sync replicates from, and an entity whose copy never
 * reached a peer would name a document the peer does not have.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const MEDIA_COPY_UPLOAD_KIND = "media-copy";

/** `metadata` is NOT a media copy. A row with no metadata (NULL) is kept. */
export function notMediaCopyDocumentWhere(metadataColumn: AnyPgColumn): SQL {
  return sql`(${metadataColumn} ->> 'uploadKind') IS DISTINCT FROM ${MEDIA_COPY_UPLOAD_KIND}`;
}
