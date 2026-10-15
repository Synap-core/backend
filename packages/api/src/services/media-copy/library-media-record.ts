/**
 * The PURE half of a Library item's media copy: what the reader's media list
 * owes, how the item's failure record reads, and how one run folds into
 * `metadata.importMedia` (the copies, read by `readLibraryItemMedia` in
 * `@synap-core/types/imports` — ONE reader for the read model, the purge,
 * the hand-off and this runner), `metadata.importMediaFailed` (the count
 * every client shows) and `metadata.importMediaFailures` (per URL: reason +
 * attempts — what decides whether a URL is tried again). No I/O.
 */

import {
  URL_READ_MEDIA_MAX,
  type UrlReadMedia,
} from "@synap-core/types/url-read";
import {
  readLibraryItemMedia,
  type LibraryItemMedia,
} from "@synap-core/types/imports";
import {
  PERMANENT_FETCH_FAILURES,
  type ImageFetchFailure,
} from "./fetch-image.js";
import type { VideoFetchFailure } from "./fetch-video.js";
import { MAX_TRANSIENT_ATTEMPTS } from "./media-plan.js";

export type LibraryMediaFailureReason =
  ImageFetchFailure | VideoFetchFailure | "store_unavailable";

/** One URL the item could not copy (`metadata.importMediaFailures[]`). */
export interface LibraryMediaFailure {
  sourceUrl: string;
  kind: UrlReadMedia["kind"];
  reason: LibraryMediaFailureReason;
  attempts: number;
  lastAttemptAt: string;
  /** Where the copy sits in the item's reading order (kept so a retry restores it). */
  order?: number;
  role?: UrlReadMedia["role"];
}

/** Refusals a retry cannot change — never fetched again for this item. */
export const PERMANENT_LIBRARY_MEDIA_FAILURES: ReadonlySet<string> = new Set([
  ...PERMANENT_FETCH_FAILURES,
  "not_video",
]);

/** The reader's media, cleaned: http(s), one per URL, ordered, capped. */
export function planLibraryMedia(
  media: readonly UrlReadMedia[]
): UrlReadMedia[] {
  const seen = new Set<string>();
  return [...media]
    .filter(
      (m) =>
        m &&
        typeof m.url === "string" &&
        /^https?:\/\/\S+$/i.test(m.url.trim()) &&
        (m.kind === "image" || m.kind === "video")
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((m) => {
      const url = m.url.trim();
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .slice(0, URL_READ_MEDIA_MAX)
    .map((m) => ({ ...m, url: m.url.trim() }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `metadata.importMediaFailures`, the well-formed entries only. */
export function readLibraryMediaFailures(
  metadata: unknown
): LibraryMediaFailure[] {
  const raw = isRecord(metadata) ? metadata.importMediaFailures : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (f): f is LibraryMediaFailure =>
      isRecord(f) &&
      typeof f.sourceUrl === "string" &&
      typeof f.reason === "string" &&
      typeof f.attempts === "number"
  );
}

export function owedLibraryMedia(
  wanted: UrlReadMedia[],
  held: LibraryItemMedia[],
  live: ReadonlySet<string>,
  failures: LibraryMediaFailure[]
): UrlReadMedia[] {
  const copied = new Set(
    held.filter((m) => live.has(m.documentId)).map((m) => m.sourceUrl)
  );
  const failed = new Map(failures.map((f) => [f.sourceUrl, f]));
  return wanted.filter((m) => {
    if (copied.has(m.url)) return false;
    const f = failed.get(m.url);
    if (!f || f.reason === "store_unavailable") return true;
    if (PERMANENT_LIBRARY_MEDIA_FAILURES.has(f.reason)) return false;
    return f.attempts < MAX_TRANSIENT_ATTEMPTS;
  });
}

/**
 * Fold one run into the item's CURRENT metadata (read under the row lock):
 * copies whose document is gone are dropped, new copies are added unless the
 * URL is already held, failures of URLs now held are cleared, new failures
 * counted. Returns only the three keys the writer sets.
 */
export function mergeLibraryMedia(
  current: unknown,
  run: {
    copied: LibraryItemMedia[];
    failed: Array<{
      sourceUrl: string;
      kind: UrlReadMedia["kind"];
      reason: LibraryMediaFailureReason;
      order?: number;
      role?: UrlReadMedia["role"];
    }>;
    at: string;
  },
  deadDocumentIds: ReadonlySet<string>
): {
  importMedia: LibraryItemMedia[];
  importMediaFailed: number;
  importMediaFailures: LibraryMediaFailure[];
} {
  const media = readLibraryItemMedia(current).media.filter(
    (m) => !deadDocumentIds.has(m.documentId)
  );
  const held = new Set(media.map((m) => m.sourceUrl));
  for (const c of run.copied) {
    if (held.has(c.sourceUrl)) continue;
    held.add(c.sourceUrl);
    media.push(c);
  }
  media.sort((a, b) => a.order - b.order);
  const failures = new Map(
    readLibraryMediaFailures(current).map((f) => [f.sourceUrl, f])
  );
  for (const url of held) failures.delete(url);
  for (const f of run.failed) {
    if (held.has(f.sourceUrl)) continue;
    const before = failures.get(f.sourceUrl);
    const order = f.order ?? before?.order;
    const role = f.role ?? before?.role;
    failures.set(f.sourceUrl, {
      sourceUrl: f.sourceUrl,
      kind: f.kind,
      reason: f.reason,
      attempts: (before?.attempts ?? 0) + 1,
      lastAttemptAt: run.at,
      ...(order !== undefined ? { order } : {}),
      ...(role ? { role } : {}),
    });
  }
  const importMediaFailures = [...failures.values()];
  return {
    importMedia: media,
    importMediaFailed: importMediaFailures.length,
    importMediaFailures,
  };
}

/**
 * The media a person's "Try again" (`library.retryMedia`) copies: EVERY URL
 * the item failed to copy and does not hold now — permanent refusals and
 * spent attempts included (the person asked; an expired link fails again and
 * says so). Reading order is the failure's own, else after what is held.
 */
export function retryLibraryMediaPlan(metadata: unknown): UrlReadMedia[] {
  const held = readLibraryItemMedia(metadata).media;
  const holds = new Set(held.map((m) => m.sourceUrl));
  let next = held.reduce((n, m) => Math.max(n, m.order + 1), 0);
  return readLibraryMediaFailures(metadata)
    .filter(
      (f) =>
        !holds.has(f.sourceUrl) && (f.kind === "image" || f.kind === "video")
    )
    .map((f) => ({
      url: f.sourceUrl,
      kind: f.kind,
      order: typeof f.order === "number" ? f.order : next++,
      ...(f.role ? { role: f.role } : {}),
    }));
}
