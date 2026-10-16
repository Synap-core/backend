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
 *             default 1 GiB) — never buffered; its sha256 is the checksum the
 *             storage upload computes as the bytes pass (one hash pass).
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
 * Never throws: every refusal is recorded on the item and counted in the
 * result; a run that failed before it could record (the database down) says
 * `failed` with the error — never the "nothing owed" of a run with no work.
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
  retryLibraryMediaPlan,
  type LibraryMediaFailureReason,
} from "./library-media-record.js";
import { libraryMediaCopyMetadata } from "./media-copy-documents.js";
import { emitLibraryItemUpdated } from "../../utils/event-emit.js";
import type { CopiedVideoMime } from "./video-sniff.js";

const logger = createLogger({ module: "library-media-copy" });

export {
  readLibraryMediaFailures,
  type LibraryMediaFailure,
} from "./library-media-record.js";

export interface CopyLibraryItemMediaResult {
  /**
   * `copied` — the run recorded its outcome on the item (`failed` counts the
   * URLs it could not copy). `skipped` — nothing to do (`reason`). `failed` —
   * the run itself failed before it could record (`error`); the item is
   * unchanged and the next read re-plans.
   */
  status: "copied" | "skipped" | "failed";
  /** Why nothing ran (`skipped`): the item is not this person's live Library item, or nothing was owed. */
  reason?: "not_found" | "nothing_owed";
  /** What failed (`failed` only). */
  error?: string;
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
  /** Stream an object into storage; `checksum` is `sha256:<hex>` of the bytes. */
  uploadStream?: (
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string
  ) => Promise<{ size: number; checksum: string }>;
  /** Adopt a streamed object as a `documents` row; returns its id. */
  adoptStoredObject?: (args: AdoptStoredObjectArgs) => Promise<string>;
  removeObject?: (key: string) => Promise<void>;
  findBySha256?: (args: {
    userId: string;
    fileSha256: string;
    mimeType: string;
  }) => Promise<{ documentId: string } | null>;
  /** Delete a minted copy the item does not hold (default: `deleteBody`). */
  discard?: (documentId: string) => Promise<void>;
  liveDocuments?: (ids: string[]) => Promise<Set<string>>;
  /**
   * Tell the owner's clients the run was recorded on the item
   * (`library:item:updated`, `what: "media"`). Default: the realtime bridge.
   */
  notify?: (input: {
    userId: string;
    itemId: string;
    metadata: unknown;
  }) => void;
  now?: () => Date;
}

interface AdoptStoredObjectArgs {
  userId: string;
  workspaceId: string | null;
  title?: string;
  storageKey: string;
  size: number;
  mimeType: string;
  filename: string;
  metadata: Record<string, unknown>;
}

type ResolvedDeps = Required<Omit<CopyLibraryItemMediaDeps, "database">> & {
  database: typeof defaultDb;
};

/** Every seam, defaulted to the real door. */
function resolveCopyDeps(deps: CopyLibraryItemMediaDeps): ResolvedDeps {
  const database = deps.database ?? defaultDb;
  return {
    database,
    fetchImage: deps.fetchImage ?? ((u) => fetchExternalImage(u)),
    fetchVideo:
      deps.fetchVideo ?? ((u, sink) => fetchExternalVideoToSink(u, sink)),
    store: deps.store ?? storeDocumentFromBuffer,
    findBySha256:
      deps.findBySha256 ??
      ((a) => findStoredDocumentBySha256({ database, ...a })),
    uploadStream:
      deps.uploadStream ??
      (async (key, body, contentType) => {
        const { storage } = await import("@synap/storage");
        const meta = await storage.uploadStream(key, body, { contentType });
        return { size: meta.size, checksum: meta.checksum };
      }),
    removeObject:
      deps.removeObject ??
      (async (key) => {
        const { storage } = await import("@synap/storage");
        await storage.delete(key);
      }),
    adoptStoredObject:
      deps.adoptStoredObject ??
      (async (a) => {
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
      }),
    discard:
      deps.discard ??
      ((documentId) =>
        new EntityBodyService(database, eventRepository).deleteBody({
          documentId,
        })),
    liveDocuments: deps.liveDocuments ?? liveDocumentIds,
    notify:
      deps.notify ??
      ((input) => emitLibraryItemUpdated({ ...input, what: "media" })),
    now: deps.now ?? (() => new Date()),
  };
}

export interface CopyLibraryItemMediaInput {
  userId: string;
  itemId: string;
  media: UrlReadMedia[];
  /**
   * The person's "Try again": copy these URLs even when the item gave up on
   * them (a permanent refusal, attempts spent). Never set by a reader run.
   */
  retryFailed?: boolean;
}

/**
 * Copy `media` (what a reader found on the item's URL) into the pod and
 * record it on the item. Owner-floored: `itemId` must be `userId`'s live
 * Library item, else nothing runs (`skipped`/`not_found`).
 */
export async function copyLibraryItemMedia(
  input: CopyLibraryItemMediaInput,
  deps: CopyLibraryItemMediaDeps = {}
): Promise<CopyLibraryItemMediaResult> {
  try {
    return await copyLibraryItemMediaUnsafe(input, resolveCopyDeps(deps));
  } catch (err) {
    // The contract is "never throws": a failure here (the DB down mid-run)
    // is logged and REPORTED as failed — never as "nothing owed". The item
    // records nothing new and the next read re-plans.
    logger.error(
      { err, itemId: input.itemId },
      "library-media-copy: the run failed before it could record"
    );
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      copied: 0,
      reused: 0,
      failed: 0,
    };
  }
}

/**
 * The person's "Try again" on "Couldn't keep the pictures"
 * (`library.retryMedia`, run by the light-read queue): copy again every URL
 * the item failed to copy — no reader run, no read budget. Honest: a link that
 * expired fails again and stays counted (`importMediaFailed`, its
 * `lastAttemptAt` moved), so the client says it and points to "Read again".
 * Nothing failed → `skipped` / `nothing_owed`. Never throws.
 */
export async function retryLibraryItemMedia(
  input: { userId: string; itemId: string },
  deps: CopyLibraryItemMediaDeps = {}
): Promise<CopyLibraryItemMediaResult> {
  const database = deps.database ?? defaultDb;
  let media: UrlReadMedia[];
  try {
    const [row] = await database
      .select({ metadata: documents.metadata })
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
    if (!row) {
      return {
        status: "skipped",
        reason: "not_found",
        copied: 0,
        reused: 0,
        failed: 0,
      };
    }
    media = retryLibraryMediaPlan(row.metadata);
  } catch (err) {
    logger.error(
      { err, itemId: input.itemId },
      "library-media-copy: the retry could not read the item"
    );
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      copied: 0,
      reused: 0,
      failed: 0,
    };
  }
  if (media.length === 0) {
    return {
      status: "skipped",
      reason: "nothing_owed",
      copied: 0,
      reused: 0,
      failed: 0,
    };
  }
  return copyLibraryItemMedia({ ...input, media, retryFailed: true }, deps);
}

interface ItemRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  metadata: unknown;
}

/** One URL's outcome. `unavailable` = pod storage is not configured at all. */
type CopyOutcome =
  | {
      kind: "copied";
      documentId: string;
      minted: boolean;
      mime: string;
      bytes: number;
      size?: { width?: number; height?: number };
    }
  | { kind: "failed"; reason: LibraryMediaFailureReason }
  | { kind: "unavailable" };

async function copyOneImage(
  m: UrlReadMedia,
  row: ItemRow,
  d: ResolvedDeps
): Promise<CopyOutcome> {
  const got = await d.fetchImage(m.url);
  if (!got.ok) return { kind: "failed", reason: got.reason };
  const sha = fileSha256Of(got.bytes);
  const copied = (documentId: string, minted: boolean): CopyOutcome => ({
    kind: "copied",
    documentId,
    minted,
    mime: got.mime,
    bytes: got.bytes.byteLength,
    size: got,
  });
  const known = await d.findBySha256({
    userId: row.userId,
    fileSha256: sha,
    mimeType: got.mime,
  });
  if (known) return copied(known.documentId, false);
  const title = row.title?.trim() || undefined;
  const stored = await d.store({
    userId: row.userId,
    workspaceId: row.workspaceId ?? null,
    buffer: got.bytes,
    mimeType: got.mime,
    filename: filenameFor(m.url, got.mime),
    title: title ? `${title} — image` : undefined,
    storedBySystem: true,
    metadata: libraryMediaCopyMetadata(row.id, sha),
  });
  return copied(stored.documentId, true);
}

const STORAGE_SHA256 = /^sha256:([0-9a-f]{64})$/;

/** VIDEO — streamed into storage, adopted as a document after. */
async function copyOneVideo(
  m: UrlReadMedia,
  row: ItemRow,
  d: ResolvedDeps
): Promise<CopyOutcome> {
  let key = "";
  const got = await d.fetchVideo(m.url, async (body, mime) => {
    key = `files/${row.workspaceId ?? "pod"}/${randomUUID()}/${filenameFor(m.url, mime)}`;
    return d.uploadStream(key, body, mime);
  });
  if (!got.ok) {
    if (got.reason === "store_failed" && isStorageUnconfigured(got.cause)) {
      return { kind: "unavailable" };
    }
    if (got.reason === "store_failed") {
      logger.warn(
        { err: got.cause, itemId: row.id, sourceUrl: m.url },
        "library-media-copy: storing the video failed"
      );
    }
    return { kind: "failed", reason: got.reason };
  }
  const sha = STORAGE_SHA256.exec(got.stored.checksum)?.[1];
  if (!sha) {
    await d.removeObject(key).catch(() => undefined);
    throw new Error("storage returned no sha256 checksum for the video");
  }
  const copied = (documentId: string, minted: boolean): CopyOutcome => ({
    kind: "copied",
    documentId,
    minted,
    mime: got.mime,
    bytes: got.bytes,
  });
  const known = await d.findBySha256({
    userId: row.userId,
    fileSha256: sha,
    mimeType: got.mime,
  });
  if (known) {
    await d
      .removeObject(key)
      .catch((err: unknown) =>
        logger.warn(
          { err, key },
          "library-media-copy: removing a duplicate video object failed"
        )
      );
    return copied(known.documentId, false);
  }
  const title = row.title?.trim() || undefined;
  try {
    const documentId = await d.adoptStoredObject({
      userId: row.userId,
      workspaceId: row.workspaceId ?? null,
      title: title ? `${title} — video` : undefined,
      storageKey: key,
      size: got.bytes,
      mimeType: got.mime,
      filename: key.split("/").pop() ?? "video",
      metadata: libraryMediaCopyMetadata(row.id, sha),
    });
    return copied(documentId, true);
  } catch (err) {
    await d.removeObject(key).catch(() => undefined);
    throw err;
  }
}

/** One URL, every throw classified (storage missing vs this copy failed). */
async function copyOne(
  m: UrlReadMedia,
  row: ItemRow,
  d: ResolvedDeps
): Promise<CopyOutcome> {
  try {
    return m.kind === "image"
      ? await copyOneImage(m, row, d)
      : await copyOneVideo(m, row, d);
  } catch (err) {
    if (isStorageUnconfigured(err)) return { kind: "unavailable" };
    logger.warn(
      { err, itemId: row.id, sourceUrl: m.url },
      "library-media-copy: storing the copy failed"
    );
    return { kind: "failed", reason: "store_failed" };
  }
}

interface FailedCopy {
  sourceUrl: string;
  kind: UrlReadMedia["kind"];
  reason: LibraryMediaFailureReason;
  order: number;
  role?: UrlReadMedia["role"];
}

/**
 * Record the run on the item under a row lock — exactly the three media keys,
 * so a person's curation edit or the light read landing meanwhile is kept.
 * Returns the document ids the item now holds (none when the item is gone),
 * and tells the owner's clients once the record is committed.
 */
async function recordLibraryItemMedia(
  d: ResolvedDeps,
  row: ItemRow,
  run: { copied: LibraryItemMedia[]; failed: FailedCopy[] },
  dead: Set<string>
): Promise<Set<string>> {
  const recorded = await d.database.transaction(async (tx) => {
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
    if (!current) return null;
    const next = mergeLibraryMedia(
      current.metadata,
      { ...run, at: d.now().toISOString() },
      dead
    );
    await tx
      .update(documents)
      .set({
        metadata: drizzleSql`COALESCE(${documents.metadata}, '{}'::jsonb) || jsonb_build_object('importMedia', ${JSON.stringify(next.importMedia)}::jsonb, 'importMediaFailed', ${next.importMediaFailed}::int, 'importMediaFailures', ${JSON.stringify(next.importMediaFailures)}::jsonb)`,
      })
      .where(eq(documents.id, row.id));
    return {
      kept: new Set(next.importMedia.map((m) => m.documentId)),
      metadata: current.metadata,
    };
  });
  if (!recorded) return new Set<string>();
  d.notify({ userId: row.userId, itemId: row.id, metadata: recorded.metadata });
  return recorded.kept;
}

async function copyLibraryItemMediaUnsafe(
  input: CopyLibraryItemMediaInput,
  d: ResolvedDeps
): Promise<CopyLibraryItemMediaResult> {
  const none = (reason: CopyLibraryItemMediaResult["reason"]) =>
    ({ status: "skipped", reason, copied: 0, reused: 0, failed: 0 }) as const;
  const [row] = await d.database
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

  const held = readLibraryItemMedia(row.metadata).media;
  const live = await d.liveDocuments(held.map((m) => m.documentId));
  const dead = new Set(
    held.map((m) => m.documentId).filter((id) => !live.has(id))
  );
  const todo = owedLibraryMedia(
    planLibraryMedia(input.media),
    held,
    live,
    input.retryFailed ? [] : readLibraryMediaFailures(row.metadata)
  );
  if (todo.length === 0 && dead.size === 0) return none("nothing_owed");

  const copied: LibraryItemMedia[] = [];
  const minted = new Set<string>();
  const failed: FailedCopy[] = [];
  for (let i = 0; i < todo.length; i++) {
    const m = todo[i]!;
    const out = await copyOne(m, row, d);
    if (out.kind === "unavailable") {
      // Not this URL's fault, and every other would fail the same way: record
      // the rest as owed (never silent) and stop downloading.
      for (const rest of todo.slice(i)) {
        failed.push({
          sourceUrl: rest.url,
          kind: rest.kind,
          reason: "store_unavailable",
          order: rest.order,
          ...(rest.role ? { role: rest.role } : {}),
        });
      }
      logger.warn(
        { itemId: row.id },
        "library-media-copy: pod storage is not configured — copies not made"
      );
      break;
    }
    if (out.kind === "failed") {
      failed.push({
        sourceUrl: m.url,
        kind: m.kind,
        reason: out.reason,
        order: m.order,
        ...(m.role ? { role: m.role } : {}),
      });
      continue;
    }
    if (out.minted) minted.add(out.documentId);
    copied.push({
      documentId: out.documentId,
      mime: out.mime,
      bytes: out.bytes,
      sourceUrl: m.url,
      ...(out.size?.width !== undefined ? { width: out.size.width } : {}),
      ...(out.size?.height !== undefined ? { height: out.size.height } : {}),
      copiedAt: d.now().toISOString(),
      kind: m.kind,
      ...(m.role ? { role: m.role } : {}),
      order: m.order,
    });
  }

  let kept = new Set<string>();
  try {
    kept = await recordLibraryItemMedia(d, row, { copied, failed }, dead);
  } finally {
    for (const documentId of minted) {
      if (kept.has(documentId)) continue;
      await d
        .discard(documentId)
        .catch((err: unknown) =>
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
