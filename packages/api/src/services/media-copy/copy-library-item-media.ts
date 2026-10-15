/**
 * Copy a LIBRARY ITEM's media into the pod — the pictures and video of a kept
 * post, copied while the reader's CDN links still work (they expire within
 * days; Build runs later and must never re-fetch).
 *
 * Lives in media-copy/, not library/: it is the SAME media-copy system as the
 * entity copy — one guarded download door (`openGuardedMedia`, via
 * `fetchExternalImage` / `fetchExternalVideoToSink`), one store-only door
 * (`storeDocumentFromBuffer`; a video adopts its streamed object through the
 * body door's stored-object mode), one marking (`media-copy-documents.ts`),
 * one failure vocabulary. Only the OWNER differs: a Library item (a
 * `documents` row with `metadata.importItem`) instead of an entity.
 *
 *   plan    → the reader's `UrlReadMedia[]`: http(s), one per URL, ordered,
 *             ≤ `URL_READ_MEDIA_MAX`; minus what the item already holds (a
 *             live copy of that URL) and what it gave up on (a permanent
 *             refusal, or a transient one tried `MAX_TRANSIENT_ATTEMPTS`).
 *   image   → `fetchExternalImage` (SSRF guard, ≤ 25 MB, magic bytes).
 *   video   → `fetchExternalVideoToSink` STREAMED into `storage.uploadStream`
 *             (mp4/webm sniffed from the bytes, ≤ `LIBRARY_MEDIA_VIDEO_MAX_BYTES`,
 *             default 1 GiB) — never buffered — with a running sha256.
 *   dedup   → the per-user bytes ledger (`metadata.intakeSource.fileSha256`,
 *             `findStoredDocumentBySha256`): the same bytes already stored as
 *             a document of this mime are REUSED (a streamed duplicate's
 *             object is deleted); new copies are written with the key so the
 *             next one finds them.
 *   record  → `metadata.importMedia` (LibraryItemMedia[], by `order`),
 *             `importMediaFailed` (the count clients show) and
 *             `importMediaFailures` (reason + attempts per URL) on the ITEM
 *             row, under a row lock, writing those three keys only — every
 *             other key (the read, the curation a person edits meanwhile) is
 *             kept.
 *   orphans → a copy this run minted that the item does not end up holding
 *             (item deleted meanwhile, a concurrent run recorded that URL
 *             first, the record failed) is discarded. A REUSED document is
 *             never discarded: it is not this run's.
 *
 * Purge: the copies go with the item (`purgeDeletedLibraryItems`, keep-alive).
 * Never throws: every refusal is recorded on the item and counted in the result.
 */

import { randomUUID } from "node:crypto";
import {
  db as defaultDb,
  documents,
  and,
  eq,
  isNull,
  drizzleSql,
  eventRepository,
  EntityBodyService,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { UrlReadMedia } from "@synap-core/types/url-read";
import {
  readLibraryItemMedia,
  type LibraryItemMedia,
} from "@synap-core/types/imports";
import { storeDocumentFromBuffer } from "../../routers/file-upload.js";
import {
  findStoredDocumentBySha256,
  fileSha256Of,
} from "../intake/known-source-hashes.js";
import { fetchExternalImage, type ImageFetchResult } from "./fetch-image.js";
import {
  fetchExternalVideoToSink,
  type VideoFetchResult,
} from "./fetch-video.js";
import { filenameFor, isStorageUnconfigured } from "./copy-entity-media.js";
import { liveDocumentIds } from "./live-documents.js";
import {
  mergeLibraryMedia,
  owedLibraryMedia,
  planLibraryMedia,
  readLibraryMediaFailures,
  type LibraryMediaFailureReason,
} from "./library-media-record.js";
import { libraryMediaCopyMetadata } from "./media-copy-documents.js";
import type { CopiedVideoMime } from "./video-sniff.js";

const logger = createLogger({ module: "library-media-copy" });

export {
  readLibraryMediaFailures,
  type LibraryMediaFailure,
} from "./library-media-record.js";

export interface CopyLibraryItemMediaResult {
  status: "copied" | "skipped";
  /** Why nothing ran (`skipped`): the item is not this person's live Library item, or nothing was owed. */
  reason?: "not_found" | "nothing_owed";
  /** Copies the item now holds from this run (stored + reused). */
  copied: number;
  /** Of those, how many reused bytes already on the pod. */
  reused: number;
  failed: number;
}

export interface CopyLibraryItemMediaDeps {
  database?: typeof defaultDb;
  fetchImage?: (url: string) => Promise<ImageFetchResult>;
  fetchVideo?: <T>(
    url: string,
    sink: (body: AsyncIterable<Uint8Array>, mime: CopiedVideoMime) => Promise<T>
  ) => Promise<VideoFetchResult<T>>;
  store?: typeof storeDocumentFromBuffer;
  uploadStream?: (
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string
  ) => Promise<{ size: number }>;
  /** Adopt a streamed object as a `documents` row; returns its id. */
  adoptStoredObject?: (args: {
    userId: string;
    workspaceId: string | null;
    title?: string;
    storageKey: string;
    size: number;
    mimeType: string;
    filename: string;
    metadata: Record<string, unknown>;
  }) => Promise<string>;
  removeObject?: (key: string) => Promise<void>;
  findBySha256?: (args: {
    userId: string;
    fileSha256: string;
    mimeType: string;
  }) => Promise<{ documentId: string } | null>;
  /** Delete a minted copy the item does not hold (default: `deleteBody`). */
  discard?: (documentId: string) => Promise<void>;
  liveDocuments?: (ids: string[]) => Promise<Set<string>>;
  now?: () => Date;
}

/**
 * Copy `media` (what a reader found on the item's URL) into the pod and
 * record it on the item. Owner-floored: `itemId` must be `userId`'s live
 * Library item, else nothing runs (`skipped`/`not_found`).
 */
export async function copyLibraryItemMedia(
  input: { userId: string; itemId: string; media: UrlReadMedia[] },
  deps: CopyLibraryItemMediaDeps = {}
): Promise<CopyLibraryItemMediaResult> {
  try {
    return await copyLibraryItemMediaUnsafe(input, deps);
  } catch (err) {
    // The contract is "never throws": a failure here (the DB down mid-run)
    // is logged; the item records nothing new and the next read re-plans.
    logger.error(
      { err, itemId: input.itemId },
      "library-media-copy: the run failed before it could record"
    );
    return { status: "skipped", copied: 0, reused: 0, failed: 0 };
  }
}

async function copyLibraryItemMediaUnsafe(
  input: { userId: string; itemId: string; media: UrlReadMedia[] },
  deps: CopyLibraryItemMediaDeps
): Promise<CopyLibraryItemMediaResult> {
  const database = deps.database ?? defaultDb;
  const none = (reason: CopyLibraryItemMediaResult["reason"]) =>
    ({ status: "skipped", reason, copied: 0, reused: 0, failed: 0 }) as const;
  const [row] = await database
    .select({
      id: documents.id,
      userId: documents.userId,
      workspaceId: documents.workspaceId,
      title: documents.title,
      metadata: documents.metadata,
    })
    .from(documents)
    .where(
      and(
        eq(documents.id, input.itemId),
        eq(documents.userId, input.userId),
        isNull(documents.deletedAt),
        drizzleSql`${documents.metadata} ? 'importItem'`
      )
    )
    .limit(1);
  if (!row) return none("not_found");

  const liveDocuments = deps.liveDocuments ?? liveDocumentIds;
  const held = readLibraryItemMedia(row.metadata).media;
  const live = await liveDocuments(held.map((m) => m.documentId));
  const dead = new Set(
    held.map((m) => m.documentId).filter((id) => !live.has(id))
  );
  const todo = owedLibraryMedia(
    planLibraryMedia(input.media),
    held,
    live,
    readLibraryMediaFailures(row.metadata)
  );
  if (todo.length === 0 && dead.size === 0) return none("nothing_owed");

  const now = deps.now ?? (() => new Date());
  const fetchImage = deps.fetchImage ?? ((u: string) => fetchExternalImage(u));
  const fetchVideo =
    deps.fetchVideo ??
    (<T>(
      u: string,
      sink: (b: AsyncIterable<Uint8Array>, m: CopiedVideoMime) => Promise<T>
    ) => fetchExternalVideoToSink(u, sink));
  const store = deps.store ?? storeDocumentFromBuffer;
  const findBySha256 =
    deps.findBySha256 ??
    ((a: { userId: string; fileSha256: string; mimeType: string }) =>
      findStoredDocumentBySha256({ database, ...a }));
  const uploadStream =
    deps.uploadStream ??
    (async (
      key: string,
      body: AsyncIterable<Uint8Array>,
      contentType: string
    ) => {
      const { storage } = await import("@synap/storage");
      return storage.uploadStream(key, body, { contentType });
    });
  const removeObject =
    deps.removeObject ??
    (async (key: string) => {
      const { storage } = await import("@synap/storage");
      await storage.delete(key);
    });
  const adoptStoredObject =
    deps.adoptStoredObject ??
    (async (
      a: Parameters<
        NonNullable<CopyLibraryItemMediaDeps["adoptStoredObject"]>
      >[0]
    ) => {
      const result = await new EntityBodyService(
        database,
        eventRepository
      ).setBody({
        entityId: randomUUID(),
        userId: a.userId,
        workspaceId: a.workspaceId,
        title: a.title,
        storedObject: {
          storageKey: a.storageKey,
          size: a.size,
          mimeType: a.mimeType,
          filename: a.filename,
          metadata: a.metadata,
        },
        // Nobody uploaded this: the pod copied it in the background.
        provenance: { createdByKind: "system", createdByUserId: a.userId },
      });
      return result.documentId as string;
    });

  const copied: LibraryItemMedia[] = [];
  const minted = new Set<string>();
  const failed: Array<{
    sourceUrl: string;
    kind: UrlReadMedia["kind"];
    reason: LibraryMediaFailureReason;
  }> = [];
  const title = row.title?.trim() || undefined;
  const record = (
    m: UrlReadMedia,
    documentId: string,
    mime: string,
    bytes: number,
    size?: { width?: number; height?: number }
  ) =>
    copied.push({
      documentId,
      mime,
      bytes,
      sourceUrl: m.url,
      ...(size?.width !== undefined ? { width: size.width } : {}),
      ...(size?.height !== undefined ? { height: size.height } : {}),
      copiedAt: now().toISOString(),
      kind: m.kind,
      ...(m.role ? { role: m.role } : {}),
      order: m.order,
    });

  for (let i = 0; i < todo.length; i++) {
    const m = todo[i]!;
    let unavailable = false;
    try {
      if (m.kind === "image") {
        const got = await fetchImage(m.url);
        if (!got.ok) {
          failed.push({ sourceUrl: m.url, kind: m.kind, reason: got.reason });
          continue;
        }
        const sha = fileSha256Of(got.bytes);
        const known = await findBySha256({
          userId: row.userId,
          fileSha256: sha,
          mimeType: got.mime,
        });
        if (known) {
          record(m, known.documentId, got.mime, got.bytes.byteLength, got);
          continue;
        }
        const stored = await store({
          userId: row.userId,
          workspaceId: row.workspaceId ?? null,
          buffer: got.bytes,
          mimeType: got.mime,
          filename: filenameFor(m.url, got.mime),
          title: title ? `${title} — image` : undefined,
          storedBySystem: true,
          metadata: libraryMediaCopyMetadata(row.id, sha),
        });
        minted.add(stored.documentId);
        record(m, stored.documentId, got.mime, got.bytes.byteLength, got);
        continue;
      }

      // VIDEO — streamed into storage, adopted as a document after.
      let key = "";
      const got = await fetchVideo(m.url, async (body, mime) => {
        key = `files/${row.workspaceId ?? "pod"}/${randomUUID()}/${filenameFor(m.url, mime)}`;
        return uploadStream(key, body, mime);
      });
      if (!got.ok) {
        if (got.reason === "store_failed" && isStorageUnconfigured(got.cause)) {
          unavailable = true;
        } else {
          failed.push({ sourceUrl: m.url, kind: m.kind, reason: got.reason });
          if (got.reason === "store_failed") {
            logger.warn(
              { err: got.cause, itemId: row.id, sourceUrl: m.url },
              "library-media-copy: storing the video failed"
            );
          }
          continue;
        }
      } else {
        const known = await findBySha256({
          userId: row.userId,
          fileSha256: got.sha256,
          mimeType: got.mime,
        });
        if (known) {
          await removeObject(key).catch((err: unknown) =>
            logger.warn(
              { err, key },
              "library-media-copy: removing a duplicate video object failed"
            )
          );
          record(m, known.documentId, got.mime, got.bytes);
          continue;
        }
        try {
          const documentId = await adoptStoredObject({
            userId: row.userId,
            workspaceId: row.workspaceId ?? null,
            title: title ? `${title} — video` : undefined,
            storageKey: key,
            size: got.bytes,
            mimeType: got.mime,
            filename: key.split("/").pop() ?? "video",
            metadata: libraryMediaCopyMetadata(row.id, got.sha256),
          });
          minted.add(documentId);
          record(m, documentId, got.mime, got.bytes);
        } catch (err) {
          await removeObject(key).catch(() => undefined);
          throw err;
        }
        continue;
      }
    } catch (err) {
      if (isStorageUnconfigured(err)) {
        unavailable = true;
      } else {
        failed.push({ sourceUrl: m.url, kind: m.kind, reason: "store_failed" });
        logger.warn(
          { err, itemId: row.id, sourceUrl: m.url },
          "library-media-copy: storing the copy failed"
        );
        continue;
      }
    }
    if (unavailable) {
      // Not this URL's fault, and every other would fail the same way: record
      // the rest as owed (never silent) and stop downloading.
      for (const rest of todo.slice(i)) {
        failed.push({
          sourceUrl: rest.url,
          kind: rest.kind,
          reason: "store_unavailable",
        });
      }
      logger.warn(
        { itemId: row.id },
        "library-media-copy: pod storage is not configured — copies not made"
      );
      break;
    }
  }

  const discard =
    deps.discard ??
    ((documentId: string) =>
      new EntityBodyService(database, eventRepository).deleteBody({
        documentId,
      }));
  let kept = new Set<string>();
  try {
    kept = await database.transaction(async (tx) => {
      const [current] = await tx
        .select({ metadata: documents.metadata })
        .from(documents)
        .where(
          and(
            eq(documents.id, row.id),
            eq(documents.userId, row.userId),
            isNull(documents.deletedAt)
          )
        )
        .for("update");
      if (!current) return new Set<string>();
      const next = mergeLibraryMedia(
        current.metadata,
        { copied, failed, at: now().toISOString() },
        dead
      );
      await tx
        .update(documents)
        .set({
          // Exactly these three keys; a person's curation edit or the light
          // read landing meanwhile is kept.
          metadata: drizzleSql`COALESCE(${documents.metadata}, '{}'::jsonb) || jsonb_build_object('importMedia', ${JSON.stringify(next.importMedia)}::jsonb, 'importMediaFailed', ${next.importMediaFailed}::int, 'importMediaFailures', ${JSON.stringify(next.importMediaFailures)}::jsonb)`,
        })
        .where(eq(documents.id, row.id));
      return new Set(next.importMedia.map((m) => m.documentId));
    });
  } finally {
    for (const documentId of minted) {
      if (kept.has(documentId)) continue;
      await discard(documentId).catch((err: unknown) =>
        logger.warn(
          { err, itemId: row.id, documentId },
          "library-media-copy: discarding an unrecorded copy failed"
        )
      );
    }
  }

  const held2 = copied.filter((c) => kept.has(c.documentId));
  return {
    status: "copied",
    copied: held2.length,
    reused: held2.filter((c) => !minted.has(c.documentId)).length,
    failed: failed.length,
  };
}
