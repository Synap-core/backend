/**
 * The pure half of the media-copy job: which external URLs an entity owes a
 * pod copy for, and how a run's outcome folds into `systemData` without
 * clobbering anything else there.
 *
 * Sources (external images are copied into the pod, never hot-linked):
 *   1. the profile's DECLARED media property (`uiHints.presentation.media.source
 *      .property`) when it holds an http(s) URL (or a list of them);
 *   2. `media-urls` — media URLs a producer handed over at capture (Apify
 *      `capture_social_post` slides, a page's og:image from the capture reader
 *      or the desktop web clip). Read for every kind: a producer put them there
 *      on purpose.
 * A profile with no presentation declaration contributes nothing from (1).
 * Neither does a LINK-family kind: its declared property (bookmark `url`) names
 * the page it links to, not an image of it — fetching it would request every
 * linked page from its site only to refuse it. Its picture arrives via (2).
 */

import {
  readEntityMediaCopies,
  type EntityMediaCopy,
  type ProfilePresentation,
} from "@synap-core/types/presentation";
import {
  PERMANENT_FETCH_FAILURES,
  type ImageFetchFailure,
} from "./fetch-image.js";

/** The property a producer writes capture-provided media URLs into. */
export const CAPTURED_MEDIA_URLS_PROPERTY = "media-urls";
/** Most URLs one entity is copied for (an Instagram carousel is ≤ 10 + cover). */
export const MAX_MEDIA_URLS_PER_ENTITY = 12;
/** A transient failure (timeout, 5xx) is retried on later runs up to this. */
export const MAX_TRANSIENT_ATTEMPTS = 3;

/**
 * The property that holds this kind's own media URL, or null. A link's
 * declared property is its REFERENT (the page), never an image of it.
 */
export function declaredMediaProperty(
  presentation: ProfilePresentation | null | undefined
): string | null {
  const source = presentation?.media?.source;
  if (!source || !("property" in source)) return null;
  return presentation?.family === "link" ? null : source.property;
}

/** One recorded failure, on `systemData.mediaCopyFailures` (visible on reads). */
export interface MediaCopyFailure {
  sourceUrl: string;
  reason: ImageFetchFailure | "store_failed";
  attempts: number;
  lastAttemptAt: string;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

function httpUrls(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter(
      (v): v is string => typeof v === "string" && HTTP_URL.test(v.trim())
    )
    .map((v) => v.trim());
}

/** Every external URL this entity names as media, deduped, declared first. */
export function collectMediaSourceUrls(
  properties: Record<string, unknown> | null | undefined,
  presentation: ProfilePresentation | null | undefined
): string[] {
  const props = properties ?? {};
  const out: string[] = [];
  const declared = declaredMediaProperty(presentation);
  if (declared) out.push(...httpUrls(props[declared]));
  out.push(...httpUrls(props[CAPTURED_MEDIA_URLS_PROPERTY]));
  return [...new Set(out)].slice(0, MAX_MEDIA_URLS_PER_ENTITY);
}

export function readMediaCopyFailures(systemData: unknown): MediaCopyFailure[] {
  if (!isRecord(systemData) || !Array.isArray(systemData.mediaCopyFailures))
    return [];
  return systemData.mediaCopyFailures.filter(
    (f): f is MediaCopyFailure =>
      isRecord(f) &&
      typeof f.sourceUrl === "string" &&
      typeof f.reason === "string" &&
      typeof f.attempts === "number"
  );
}

/**
 * The URLs to fetch now: named, not yet copied (idempotency by `sourceUrl`),
 * and not given up on (a permanent refusal is final; a transient one is retried
 * up to {@link MAX_TRANSIENT_ATTEMPTS}).
 */
export function planMediaCopy(input: {
  properties: Record<string, unknown> | null | undefined;
  systemData: unknown;
  presentation: ProfilePresentation | null | undefined;
}): string[] {
  const copied = new Set(
    readEntityMediaCopies(input.systemData).map((m) => m.sourceUrl)
  );
  const failures = new Map(
    readMediaCopyFailures(input.systemData).map((f) => [f.sourceUrl, f])
  );
  return collectMediaSourceUrls(input.properties, input.presentation).filter(
    (url) => {
      if (copied.has(url)) return false;
      const failed = failures.get(url);
      if (!failed) return true;
      if (PERMANENT_FETCH_FAILURES.has(failed.reason as ImageFetchFailure))
        return false;
      return failed.attempts < MAX_TRANSIENT_ATTEMPTS;
    }
  );
}

/** First retry of a transient failure waits this long; each next one doubles. */
export const TRANSIENT_RETRY_BASE_SECONDS = 15 * 60;

/**
 * When this run's failures leave a TRANSIENT one still owed (not permanent,
 * attempts < {@link MAX_TRANSIENT_ATTEMPTS}), the delay before the follow-up
 * run: base × 2^(attempts−1) of the most-attempted one. `null` = nothing to
 * retry. Without a follow-up, a transient failure (a 5xx, a timeout) was only
 * retried if the entity happened to be edited again — never, for most.
 * Bounded: the plan stops owing the URL at the attempt cap, so the chain ends.
 */
export function transientRetryDelaySeconds(
  failures: MediaCopyFailure[],
  failedThisRun: ReadonlySet<string>
): number | null {
  let attempts = 0;
  for (const f of failures) {
    if (!failedThisRun.has(f.sourceUrl)) continue;
    if (PERMANENT_FETCH_FAILURES.has(f.reason as ImageFetchFailure)) continue;
    if (f.attempts >= MAX_TRANSIENT_ATTEMPTS) continue;
    attempts = Math.max(attempts, f.attempts);
  }
  return attempts === 0
    ? null
    : TRANSIENT_RETRY_BASE_SECONDS * 2 ** (attempts - 1);
}

/**
 * Fold one run into the CURRENT `systemData` (read under the row lock):
 * `media` gains each new copy whose `sourceUrl` it does not already hold;
 * `mediaCopyFailures` drops the URLs that now succeeded and records each new
 * failure with its attempt count. Returns only those two keys — the writer
 * `jsonb_set`s them, so every other systemData key is left as it is.
 */
export function mergeMediaSystemData(
  current: unknown,
  run: {
    copied: EntityMediaCopy[];
    failed: Array<{ sourceUrl: string; reason: MediaCopyFailure["reason"] }>;
    at: string;
  }
): { media: EntityMediaCopy[]; mediaCopyFailures: MediaCopyFailure[] } {
  const existingMedia =
    isRecord(current) && Array.isArray(current.media)
      ? (current.media as EntityMediaCopy[])
      : [];
  const held = new Set(readEntityMediaCopies(current).map((m) => m.sourceUrl));
  const media = [...existingMedia];
  for (const copy of run.copied) {
    if (held.has(copy.sourceUrl)) continue;
    held.add(copy.sourceUrl);
    media.push(copy);
  }

  const previous = new Map(
    readMediaCopyFailures(current).map((f) => [f.sourceUrl, f])
  );
  for (const url of held) previous.delete(url);
  for (const f of run.failed) {
    if (held.has(f.sourceUrl)) continue;
    const before = previous.get(f.sourceUrl);
    previous.set(f.sourceUrl, {
      sourceUrl: f.sourceUrl,
      reason: f.reason,
      attempts: (before?.attempts ?? 0) + 1,
      lastAttemptAt: run.at,
    });
  }
  return { media, mediaCopyFailures: [...previous.values()] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
