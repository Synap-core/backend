/**
 * Library thumbnail BACKFILL — copy the card picture of every Library item
 * kept before the Library copied media.
 *
 * Clients draw a Library thumbnail ONLY from a pod-held copy
 * (`metadata.importMedia`); the old hot-link of `importItem.card.imageUrl` is
 * gone. Items read before the media copy existed hold no copy, and the sweep
 * never re-reads a `read` item — so without this pass they show the platform
 * tile forever.
 *
 * ONE copy path: each in-scope item's card image goes through
 * `copyLibraryItemMedia` (SSRF guard, ≤ 25 MB, magic bytes, dedup, record on
 * the item) as a single `image` cover — no reader runs, nothing is billed, no
 * page is fetched.
 *
 * An EXPIRED signed CDN link (old Instagram / TikTok posts: `oe=` /
 * `x-expires` in the past, `isExpiredSignedMediaUrl`) is SKIPPED before any
 * fetch — no request, no failure recorded, no error mark: the item is marked
 * `importMediaSkipped` (`library-media-skip.ts`) and draws the platform tile.
 * Those items are the `missingMedia` scope of `library.readers` / `readWith`
 * ("Get pictures for N old posts with X"). A link whose expiry is unknown, or
 * still in the future, is fetched as before.
 *
 * Scope (SQL): live Library items (`metadata ? 'importItem'`) holding NO copy
 * (`importMedia` absent or empty) whose card image is an http(s) URL.
 *
 * Shape of the run:
 *   - bounded: keyset pages of {@link LIBRARY_MEDIA_BACKFILL_BATCH} by
 *     `documents.id`, at most {@link LIBRARY_MEDIA_BACKFILL_RUN_MAX} items per
 *     run (the next boot resumes);
 *   - rate-limited: one item at a time, {@link LIBRARY_MEDIA_BACKFILL_SPACING_MS}
 *     apart (one image fetch each);
 *   - resumable: the cursor (`pod_settings.settings.libraryMediaBackfill`) is
 *     written after every page. A copy RUN that failed (`status: "failed"`, the
 *     database down) stops the pass and throws BEFORE the cursor passes that
 *     page — the next boot retries it.
 *
 * THE MARKER asserts only what this pass did: "every in-scope item up to
 * `cursor` (scope v{@link LIBRARY_MEDIA_BACKFILL_VERSION}) was handed to the
 * copy door"; `completedAt` adds "…and the scan reached the end". Whether a
 * picture was COPIED is the item's own record (`importMedia` /
 * `importMediaFailures`).
 */

import {
  db,
  and,
  asc,
  gt,
  isNull,
  drizzleSql,
  documents,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  isExpiredSignedMediaUrl,
  signedMediaUrlExpiresAt,
  type UrlReadMedia,
} from "@synap-core/types/url-read";
import {
  markLibraryMediaSkipped,
  type LibraryMediaSkip,
} from "./library-media-skip.js";
import {
  copyLibraryItemMedia,
  type CopyLibraryItemMediaResult,
} from "./copy-library-item-media.js";
import {
  readPodSettingsKey,
  writePodSettingsKey,
} from "./backfill-media-copy.js";

const logger = createLogger({ module: "library-media-backfill" });

/**
 * Bump when the scope rule changes: a blinder pass's stamp stops counting.
 * v2: expired signed links are skipped before fetching (and a v1 failure for
 * such a link is replaced by the skip mark).
 */
export const LIBRARY_MEDIA_BACKFILL_VERSION = 2;
export const LIBRARY_MEDIA_BACKFILL_SETTINGS_KEY = "libraryMediaBackfill";
export const LIBRARY_MEDIA_BACKFILL_BATCH = 100;
/** Items one run hands to the copy door at most (the next boot resumes). */
export const LIBRARY_MEDIA_BACKFILL_RUN_MAX = 2000;
/** One item every this-many milliseconds (≈ 1 200 image fetches an hour). */
export const LIBRARY_MEDIA_BACKFILL_SPACING_MS = 3000;

export interface LibraryMediaBackfillMarker {
  version: number;
  /** Last `documents.id` whose page was fully handed over; null = none yet. */
  cursor: string | null;
  scanned: number;
  /** Items that now hold a copy from this pass (copied or reused bytes). */
  copied: number;
  /** Items whose card image could not be copied (recorded on the item). */
  failed: number;
  /** Items whose card image link had expired: skipped, never fetched. */
  skipped: number;
  startedAt: string;
  completedAt?: string;
}

export interface LibraryMediaBackfillDeps {
  copy?: (input: {
    userId: string;
    itemId: string;
    media: UrlReadMedia[];
  }) => Promise<CopyLibraryItemMediaResult>;
  /** Test seam: the skip mark (`markLibraryMediaSkipped`). */
  markSkipped?: (itemId: string, skip: LibraryMediaSkip) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  batchSize?: number;
  runMax?: number;
  spacingMs?: number;
}

export interface LibraryMediaBackfillResult {
  status: "already-complete" | "completed" | "paused";
  scanned: number;
  copied: number;
  failed: number;
  skipped: number;
}

async function readMarker(): Promise<LibraryMediaBackfillMarker | null> {
  const raw = await readPodSettingsKey(LIBRARY_MEDIA_BACKFILL_SETTINGS_KEY);
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Partial<LibraryMediaBackfillMarker>;
  if (m.version !== LIBRARY_MEDIA_BACKFILL_VERSION) return null;
  return {
    version: m.version,
    cursor: typeof m.cursor === "string" ? m.cursor : null,
    scanned: typeof m.scanned === "number" ? m.scanned : 0,
    copied: typeof m.copied === "number" ? m.copied : 0,
    failed: typeof m.failed === "number" ? m.failed : 0,
    skipped: typeof m.skipped === "number" ? m.skipped : 0,
    startedAt: typeof m.startedAt === "string" ? m.startedAt : "",
    ...(typeof m.completedAt === "string"
      ? { completedAt: m.completedAt }
      : {}),
  };
}

const CARD_IMAGE = drizzleSql`(${documents.metadata} -> 'importItem' -> 'card' ->> 'imageUrl')`;

/** Live Library items with no pod copy and an http(s) card image. */
const IN_SCOPE = and(
  isNull(documents.deletedAt),
  drizzleSql`${documents.metadata} ? 'importItem'`,
  drizzleSql`(jsonb_typeof(${documents.metadata} -> 'importMedia') IS DISTINCT FROM 'array' OR jsonb_array_length(${documents.metadata} -> 'importMedia') = 0)`,
  drizzleSql`${CARD_IMAGE} ~* '^https?://'`
);

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run (or resume) the pass. Idempotent: a completed stamp returns at once.
 * Throws when a copy RUN fails (nothing recorded) — the cursor stays on the
 * last page fully handed over, and the next boot resumes there.
 */
export async function backfillLibraryItemMedia(
  deps: LibraryMediaBackfillDeps = {}
): Promise<LibraryMediaBackfillResult> {
  const copy = deps.copy ?? ((input) => copyLibraryItemMedia(input));
  const markSkipped =
    deps.markSkipped ??
    ((itemId: string, skip: LibraryMediaSkip) =>
      markLibraryMediaSkipped(db, itemId, skip));
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => new Date());
  const batchSize = deps.batchSize ?? LIBRARY_MEDIA_BACKFILL_BATCH;
  const runMax = deps.runMax ?? LIBRARY_MEDIA_BACKFILL_RUN_MAX;
  const spacingMs = deps.spacingMs ?? LIBRARY_MEDIA_BACKFILL_SPACING_MS;

  const previous = await readMarker();
  if (previous?.completedAt) {
    return {
      status: "already-complete",
      scanned: previous.scanned,
      copied: previous.copied,
      failed: previous.failed,
      skipped: previous.skipped,
    };
  }
  const marker: LibraryMediaBackfillMarker = previous ?? {
    version: LIBRARY_MEDIA_BACKFILL_VERSION,
    cursor: null,
    scanned: 0,
    copied: 0,
    failed: 0,
    skipped: 0,
    startedAt: now().toISOString(),
  };

  let handled = 0;
  let first = true;
  for (;;) {
    const want = Math.min(batchSize, runMax - handled);
    if (want <= 0) {
      logger.info(marker, "library media backfill: paused at the run cap");
      return {
        status: "paused",
        scanned: marker.scanned,
        copied: marker.copied,
        failed: marker.failed,
        skipped: marker.skipped,
      };
    }
    const page = await db
      .select({
        id: documents.id,
        userId: documents.userId,
        imageUrl: drizzleSql<string>`${CARD_IMAGE}`,
      })
      .from(documents)
      .where(
        marker.cursor
          ? and(IN_SCOPE, gt(documents.id, marker.cursor))
          : IN_SCOPE
      )
      .orderBy(asc(documents.id))
      .limit(want);

    for (const row of page) {
      const url = row.imageUrl.trim();
      const at = now();
      const expiresAt = signedMediaUrlExpiresAt(url);
      if (expiresAt !== null && isExpiredSignedMediaUrl(url, at.getTime())) {
        // Dead before we ask: no request, no failure, no spacing spent.
        await markSkipped(row.id, {
          reason: "expired",
          sourceUrl: url,
          expiredAt: new Date(expiresAt).toISOString(),
          at: at.toISOString(),
        });
        marker.skipped++;
        continue;
      }
      if (!first) await sleep(spacingMs);
      first = false;
      const result = await copy({
        userId: row.userId,
        itemId: row.id,
        media: [{ url, kind: "image", role: "cover", order: 0 }],
      });
      if (result.status === "failed") {
        // Nothing recorded on the item: stop here, the next boot retries
        // this page (the cursor has not passed it).
        await writePodSettingsKey(LIBRARY_MEDIA_BACKFILL_SETTINGS_KEY, marker);
        throw new Error(
          `library media backfill: the copy run failed on ${row.id}: ${result.error ?? "unknown"}`
        );
      }
      if (result.copied > 0) marker.copied++;
      if (result.failed > 0) marker.failed++;
    }
    handled += page.length;
    if (page.length > 0) {
      marker.cursor = page[page.length - 1]!.id;
      marker.scanned += page.length;
    }
    if (page.length < want) {
      marker.completedAt = now().toISOString();
      await writePodSettingsKey(LIBRARY_MEDIA_BACKFILL_SETTINGS_KEY, marker);
      logger.info(marker, "library media backfill: scan complete");
      return {
        status: "completed",
        scanned: marker.scanned,
        copied: marker.copied,
        failed: marker.failed,
        skipped: marker.skipped,
      };
    }
    await writePodSettingsKey(LIBRARY_MEDIA_BACKFILL_SETTINGS_KEY, marker);
  }
}
