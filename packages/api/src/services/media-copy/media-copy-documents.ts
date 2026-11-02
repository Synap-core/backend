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
 *
 * A LIBRARY ITEM's media copy (the pictures / video of a kept post, copied
 * before the CDN link expires) is the same kind of row: `uploadKind:
 * "media-copy"` — so every list that leaves entity copies out leaves these
 * out too, with no second predicate — plus `mediaCopyOfLibraryItem = <itemId>`
 * (the item that minted it; purge deletes only such rows) and
 * `intakeSource.fileSha256` (the per-user bytes ledger, so the same bytes
 * kept twice are stored once). It belongs to the item and goes with it.
 */
// The predicate lives in `@synap/database` (`filed-document.ts`) beside the
// rest of "is this a filed document?", so the search indexer can use it too.
export { notMediaCopyDocumentWhere } from "@synap/database";

// The mark is a literal here, not a re-export: the store path
// (`file-upload.ts`) reads it at module load and its tests mock
// `@synap/database` whole. `media-copy-documents.pglite.test.ts` pins it equal
// to `@synap/database`'s.
export const MEDIA_COPY_UPLOAD_KIND = "media-copy";

/** The metadata key naming the Library item a media copy was minted for. */
export const LIBRARY_MEDIA_COPY_OF = "mediaCopyOfLibraryItem";

/** `documents.metadata` of a Library item's media copy. */
export function libraryMediaCopyMetadata(
  itemId: string,
  fileSha256: string
): Record<string, unknown> {
  return {
    uploadKind: MEDIA_COPY_UPLOAD_KIND,
    [LIBRARY_MEDIA_COPY_OF]: itemId,
    intakeSource: { fileSha256 },
  };
}
