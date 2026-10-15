/**
 * Library → entity HAND-OFF: when the entity media copy owes a URL that the
 * same person already holds as a Library item's copy (matched on
 * `sourceUrl`), the entity gets those bytes from the pod's own storage instead
 * of fetching the URL again — by Build time a social CDN link has usually
 * expired, and the Library copied it while it still worked.
 *
 * Re-store, not share: the bytes are read back from the Library copy's blob
 * and the entity runner stores its OWN document through the same store-only
 * door as a fetched image. Each document keeps an independent lifecycle — the
 * item's purge never takes the entity's picture with it, and deleting the
 * entity never touches the item. (An image is ≤ 25 MB, which the entity copy
 * holds in memory anyway; the entity copy is images-only, so a Library VIDEO
 * is not handed off — that URL is fetched and refused as before.)
 *
 * The bytes are re-sniffed (never the stored mime alone) and must fit the
 * image caps. Anything unusable answers `null` and the runner fetches as it
 * always did. Owner-floored: only `userId`'s own live Library items count.
 */

import {
  db as defaultDb,
  documents,
  and,
  eq,
  isNull,
  desc,
  drizzleSql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  MEDIA_COPY_MAX_BYTES,
  exceedsImageBounds,
  type ImageFetchResult,
} from "./fetch-image.js";
import { sniffImageSize, sniffImageType } from "./image-sniff.js";
import { readLibraryItemMedia } from "@synap-core/types/imports";

const logger = createLogger({ module: "library-media-handoff" });

export interface LibraryHandoffDeps {
  database?: typeof defaultDb;
  download?: (storageKey: string) => Promise<Buffer>;
}

/** The image a Library item of `userId` already copied from `sourceUrl`, or null. */
export async function imageFromLibraryCopy(
  userId: string,
  sourceUrl: string,
  deps: LibraryHandoffDeps = {}
): Promise<Extract<ImageFetchResult, { ok: true }> | null> {
  const database = deps.database ?? defaultDb;
  try {
    const items = await database
      .select({ metadata: documents.metadata })
      .from(documents)
      .where(
        and(
          eq(documents.userId, userId),
          isNull(documents.deletedAt),
          drizzleSql`${documents.metadata} ? 'importItem'`,
          drizzleSql`(${documents.metadata} -> 'importMedia') @> ${JSON.stringify([{ sourceUrl }])}::jsonb`
        )
      )
      .orderBy(desc(documents.createdAt))
      .limit(5);
    for (const item of items) {
      const copy = readLibraryItemMedia(item.metadata).media.find(
        (m) => m.sourceUrl === sourceUrl && m.kind === "image"
      );
      if (!copy) continue;
      const [doc] = await database
        .select({ storageKey: documents.storageKey, size: documents.size })
        .from(documents)
        .where(
          and(
            eq(documents.id, copy.documentId),
            eq(documents.userId, userId),
            isNull(documents.deletedAt)
          )
        )
        .limit(1);
      if (!doc?.storageKey || doc.size > MEDIA_COPY_MAX_BYTES) continue;
      const download =
        deps.download ??
        (async (key: string) => {
          const { storage } = await import("@synap/storage");
          return storage.downloadBuffer(key);
        });
      const bytes = await download(doc.storageKey);
      if (bytes.byteLength === 0 || bytes.byteLength > MEDIA_COPY_MAX_BYTES)
        continue;
      const mime = sniffImageType(bytes);
      if (!mime) continue;
      const size = sniffImageSize(bytes, mime);
      if (size && exceedsImageBounds(size)) continue;
      return { ok: true, bytes, mime, ...(size ?? {}) };
    }
    return null;
  } catch (err) {
    // The hand-off is a shortcut: when it cannot answer, the runner fetches.
    logger.warn(
      { err, sourceUrl },
      "library-media-handoff: reading the Library copy failed — fetching instead"
    );
    return null;
  }
}
