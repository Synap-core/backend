/**
 * The pure half of the media-copy job: which external URLs an entity owes a
 * pod copy for, and how a run's outcome folds into `systemData` without
 * clobbering anything else there.
 *
 * Sources (external images are copied into the pod, never hot-linked):
 *   1. the profile's DECLARED media sources (`uiHints.presentation.media.source`
 *      then its `fallbacks`), walked in the resolver's order: the first source
 *      that yields anything (an http(s) URL, a stored id, the linked document)
 *      is the entity's media, and only an http(s) URL there is copied — a
 *      fallback is never fetched while an earlier source already answers;
 *   2. `media-urls` — media URLs a producer handed over at capture (Apify
 *      `capture_social_post` slides, a page's og:image from the capture reader
 *      or the desktop web clip). Read for every kind: a producer put them there
 *      on purpose.
 * A profile with no presentation declaration contributes nothing from (1).
 * Neither does a LINK-family kind: its declared property (bookmark `url`) names
 * the page it links to, not an image of it — fetching it would request every
 * linked page from its site only to refuse it. Its picture arrives via (2).
 *
 * A copy whose source the entity no longer names (the avatar URL changed, a
 * media-url was removed) is PRUNED on the next run, and a copy whose document
 * is gone (someone deleted it) is treated as never made: the URL is owed again.
 */

import {
  declaredMediaSources,
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
  /**
   * `store_unavailable`: the pod has no usable storage (its provider is not
   * configured). Not the URL's fault and not a transient blip: never counted
   * toward giving up, never retried by a follow-up — the next edit (or a
   * backfill re-scan) re-plans it once storage exists.
   */
  reason: ImageFetchFailure | "store_failed" | "store_unavailable";
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

const STORED_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The http(s) URLs the DECLARED sources make this entity's media, walked in
 * the resolver's order (`resolveEntityMedia` (a)/(b)): the first source that
 * yields anything stops the walk. A LINK's `source` is its page — it yields
 * (the resolver draws its derived copy) but is never fetched.
 */
function declaredMediaUrls(
  props: Record<string, unknown>,
  presentation: ProfilePresentation | null | undefined,
  documentId: string | null | undefined
): string[] {
  const sources = declaredMediaSources(presentation);
  for (const [i, source] of sources.entries()) {
    if ("property" in source) {
      const value = props[source.property];
      const urls = httpUrls(value);
      if (urls.length > 0) {
        return i === 0 && presentation?.family === "link" ? [] : urls;
      }
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string" && STORED_ID.test(first.trim())) return [];
    } else if ("documentId" in source) {
      if (documentId) return [];
    } else {
      const ref = props[source.entityRef];
      const first = Array.isArray(ref) ? ref[0] : ref;
      if (typeof first === "string" && STORED_ID.test(first.trim())) return [];
    }
  }
  return [];
}

/** Every external URL this entity names as media, deduped, declared first. */
export function collectMediaSourceUrls(
  properties: Record<string, unknown> | null | undefined,
  presentation: ProfilePresentation | null | undefined,
  documentId?: string | null
): string[] {
  const props = properties ?? {};
  const out = [
    ...declaredMediaUrls(props, presentation, documentId),
    ...httpUrls(props[CAPTURED_MEDIA_URLS_PROPERTY]),
  ];
  return [...new Set(out)].slice(0, MAX_MEDIA_URLS_PER_ENTITY);
}

/**
 * The property names the plan may read media URLs from — every declared
 * property source and fallback, minus a link's page. The backfill's scope and
 * coverage hash are built from it, so a kind that gains a fallback re-scans.
 */
export function declaredMediaProperties(
  presentation: ProfilePresentation | null | undefined
): string[] {
  return declaredMediaSources(presentation).flatMap((source, i) =>
    "property" in source && !(i === 0 && presentation?.family === "link")
      ? [source.property]
      : []
  );
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
  /** The entity's linked document (a `{documentId: true}` source). */
  documentId?: string | null;
  /**
   * The copy documents that still exist. When given, a copy whose document is
   * gone does not count as copied — its URL is owed again.
   */
  liveCopyDocumentIds?: ReadonlySet<string>;
}): string[] {
  const live = input.liveCopyDocumentIds;
  const copied = new Set(
    readEntityMediaCopies(input.systemData)
      .filter((m) => !live || live.has(m.documentId))
      .map((m) => m.sourceUrl)
  );
  const failures = new Map(
    readMediaCopyFailures(input.systemData).map((f) => [f.sourceUrl, f])
  );
  return collectMediaSourceUrls(
    input.properties,
    input.presentation,
    input.documentId
  ).filter((url) => {
    if (copied.has(url)) return false;
    const failed = failures.get(url);
    if (!failed || failed.reason === "store_unavailable") return true;
    if (PERMANENT_FETCH_FAILURES.has(failed.reason as ImageFetchFailure))
      return false;
    return failed.attempts < MAX_TRANSIENT_ATTEMPTS;
  });
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
    if (f.reason === "store_unavailable") continue;
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
 *
 * With `keep` (computed from the LOCKED row), a copy is dropped — returned in
 * `pruned` so its blob can be discarded — when the entity no longer names its
 * `sourceUrl` (`keep.sources`) or its document is known to be gone
 * (`keep.deadDocumentIds` — a copy recorded by a concurrent run is unknown, not dead).
 * A failure for a URL no longer named is dropped too.
 */
export function mergeMediaSystemData(
  current: unknown,
  run: {
    copied: EntityMediaCopy[];
    failed: Array<{ sourceUrl: string; reason: MediaCopyFailure["reason"] }>;
    at: string;
  },
  keep?: {
    sources: ReadonlySet<string>;
    deadDocumentIds?: ReadonlySet<string>;
  }
): {
  media: EntityMediaCopy[];
  mediaCopyFailures: MediaCopyFailure[];
  pruned: EntityMediaCopy[];
} {
  const existingMedia =
    isRecord(current) && Array.isArray(current.media)
      ? (current.media as EntityMediaCopy[])
      : [];
  const named = (url: unknown) =>
    !keep || (typeof url === "string" && keep.sources.has(url));
  const alive = (m: EntityMediaCopy) =>
    typeof m?.documentId === "string" &&
    !keep?.deadDocumentIds?.has(m.documentId);
  const media: EntityMediaCopy[] = [];
  const pruned: EntityMediaCopy[] = [];
  for (const m of existingMedia) {
    if (named(m?.sourceUrl) && alive(m)) media.push(m);
    else pruned.push(m);
  }
  const held = new Set(
    readEntityMediaCopies({ media }).map((m) => m.sourceUrl)
  );
  for (const copy of run.copied) {
    if (held.has(copy.sourceUrl) || !named(copy.sourceUrl)) continue;
    held.add(copy.sourceUrl);
    media.push(copy);
  }

  const previous = new Map(
    readMediaCopyFailures(current)
      .filter((f) => named(f.sourceUrl))
      .map((f) => [f.sourceUrl, f])
  );
  for (const url of held) previous.delete(url);
  for (const f of run.failed) {
    if (held.has(f.sourceUrl) || !named(f.sourceUrl)) continue;
    const before = previous.get(f.sourceUrl);
    previous.set(f.sourceUrl, {
      sourceUrl: f.sourceUrl,
      reason: f.reason,
      attempts: (before?.attempts ?? 0) + 1,
      lastAttemptAt: run.at,
    });
  }
  return { media, mediaCopyFailures: [...previous.values()], pruned };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
