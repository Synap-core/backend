/**
 * deleteDocumentAndBlobs — the ONE door for removing a document row together with
 * every object it owns in storage.
 *
 * WHY THIS EXISTS. `documents.delete` did this correctly; `views.delete` did NOT.
 * Deleting a whiteboard ran a bare `db.delete(documents)` with no storage call, so:
 *
 *   · the board's full tldraw snapshot (`whiteboards/{userId}/{documentId}.json`,
 *     written by `packages/realtime/src/yjs-server.ts`) was orphaned in MinIO
 *     permanently — nothing lists it, nothing counts it, nothing reclaims it; and
 *   · `document_versions.documentId` is `ON DELETE CASCADE`
 *     (`packages/database/src/schema/documents.ts`), so the version rows were dropped
 *     FIRST, taking with them the only record of their own `storageKey`s. Those blobs
 *     leaked too, and became unreachable in the same statement.
 *
 * There is no reaper anywhere that would have caught either: `pod-hygiene-sweep`
 * derives blob keys FROM `documents` rows it is about to delete, so a blob whose row
 * is already gone is invisible to it, and no worker scans storage.
 *
 * Callers must have already authorized the delete — this helper performs NO
 * permission check. It is deliberately about bytes, not about who may remove them.
 *
 * Storage deletes use `allSettled`: a blob that is already absent must not abort the
 * rest of the cleanup, and the row is gone regardless. A failure here leaks an object
 * (recoverable, and no worse than today) rather than leaving a live row pointing at
 * deleted bytes (unrecoverable).
 */

import { db, eq, documents, documentVersions } from "@synap/database";
import { storage } from "@synap/storage";

export async function deleteDocumentAndBlobs(
  documentId: string
): Promise<void> {
  // Read the version keys BEFORE the row is deleted — the CASCADE removes them.
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
    columns: { id: true, storageKey: true },
  });
  if (!doc) return;

  const versions = await db.query.documentVersions.findMany({
    where: eq(documentVersions.documentId, documentId),
    columns: { storageKey: true },
  });

  await db.delete(documents).where(eq(documents.id, documentId));

  const keys = [doc.storageKey, ...versions.map((v) => v.storageKey)].filter(
    (k): k is string => !!k
  );

  const results = await Promise.allSettled(keys.map((k) => storage.delete(k)));
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed > 0) {
    // Loud, not silent: a leaked object is the exact failure mode this file exists
    // to close, so it must be visible in logs rather than swallowed.
    console.error(
      `[deleteDocumentAndBlobs] document=${documentId}: ${failed}/${keys.length} storage objects failed to delete and are now orphaned`
    );
  }
}
