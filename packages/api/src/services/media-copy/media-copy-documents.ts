/**
 * A media copy's `documents` row is the entity's picture, held by the pod —
 * not a document anyone filed. It is marked at store time
 * (`metadata.uploadKind = "media-copy"`, `metadata.mediaCopyOf = <entityId>`)
 * and every document LIST leaves it out (Files, the mention picker). It is
 * still a real document: the file door signs it and the entity's systemData
 * names it. Its `document.create.completed` event stays: it is the one fact
 * every document write emits (event log, SSE, peer sync, audit), and
 * silencing it would take an event-less write path in DocumentRepository for
 * this one caller. The harm the event did cause — copies flooding document
 * lists — is this exclusion's job. (Peers never ADOPT a copy: replication
 * strips `systemData.media`, see `withoutPodMedia` in sync-materializer.)
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const MEDIA_COPY_UPLOAD_KIND = "media-copy";

/** `metadata` is NOT a media copy. A row with no metadata (NULL) is kept. */
export function notMediaCopyDocumentWhere(metadataColumn: AnyPgColumn): SQL {
  return sql`(${metadataColumn} ->> 'uploadKind') IS DISTINCT FROM ${MEDIA_COPY_UPLOAD_KIND}`;
}
