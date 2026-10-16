/**
 * Fetch ONE external image for the media-copy job: SSRF-guarded, streamed under
 * a hard byte cap and a timeout, and accepted only when the bytes themselves
 * prove an allowed raster type.
 *
 *   • guard   → `validateExternalUrl` + `safePublicFetch`: on every redirect
 *               hop the hostname is resolved, refused when ANY address is
 *               private/loopback/link-local/metadata, and the socket is pinned
 *               to the vetted address (DNS rebinding closed). The URL came
 *               from entity content, so nothing private is ever a target.
 *   • size    → a truthful `Content-Length` over the cap is refused before a
 *               byte is read; a server that omits or lies about it is cut off
 *               the moment the streamed total passes the cap (the body is
 *               cancelled — never `arrayBuffer()` on an unbounded stream).
 *   • type    → the first bytes are sniffed as soon as they arrive; anything
 *               that is not png/jpeg/gif/webp (SVG, HTML, video…) is refused
 *               and the download stops there. `Content-Type` is never trusted.
 *
 * Never throws: every refusal is a typed reason the caller records.
 */

import {
  safePublicFetch,
  validateExternalUrl,
  type SafePublicFetchInit,
  type ValidateUrlResult,
} from "@synap/shared-utils";
import {
  COPIED_IMAGE_ACCEPT,
  SNIFF_HEAD_BYTES,
  sniffImageSize,
  sniffImageType,
  type CopiedImageMime,
} from "./image-sniff.js";
import { PERMANENT_LIBRARY_MEDIA_FAILURES } from "@synap-core/types/imports";

/** Images up to 25 MB: a large photo fits, a video or a dump does not. */
export const MEDIA_COPY_MAX_BYTES = 25 * 1024 * 1024;
/**
 * A decoder allocates width × height × 4 bytes whatever the file size: a tiny
 * crafted header can claim a 60k × 60k canvas (a decompression bomb for every
 * client that draws it). Refused past either bound.
 */
export const MEDIA_COPY_MAX_SIDE = 16_384;
export const MEDIA_COPY_MAX_PIXELS = 100_000_000;
const TIMEOUT_MS = 30_000;
const REDIRECT_HOPS = 3;

export type ImageFetchFailure =
  | "blocked"
  /** 403 / 404 / 410: the link no longer serves the file (an expired CDN signature). */
  | "expired"
  | "http_4xx"
  /** 408 Request Timeout / 429 Too Many Requests: the server says "later". */
  | "http_retry_later"
  | "http_5xx"
  | "too_large"
  | "not_image"
  | "empty"
  | "timeout"
  | "fetch_failed";

/**
 * Reasons a retry cannot change — recorded once, never fetched again. THE
 * list is the stored vocabulary's (`PERMANENT_LIBRARY_MEDIA_FAILURES`, which
 * clients read to hide a "Try again" that cannot work).
 */
export const PERMANENT_FETCH_FAILURES: ReadonlySet<string> = new Set(
  PERMANENT_LIBRARY_MEDIA_FAILURES
);

export type ImageFetchResult =
  | {
      ok: true;
      bytes: Buffer;
      mime: CopiedImageMime;
      width?: number;
      height?: number;
    }
  | { ok: false; reason: ImageFetchFailure };

export interface FetchImageDeps {
  fetch?: (
    url: string,
    init?: SafePublicFetchInit,
    maxRedirects?: number
  ) => Promise<Response>;
  validate?: (raw: string) => ValidateUrlResult;
  maxBytes?: number;
  timeoutMs?: number;
}

/** Past either decoder bound ({@link MEDIA_COPY_MAX_SIDE}, {@link MEDIA_COPY_MAX_PIXELS})? */
export function exceedsImageBounds(size: {
  width: number;
  height: number;
}): boolean {
  return (
    size.width > MEDIA_COPY_MAX_SIDE ||
    size.height > MEDIA_COPY_MAX_SIDE ||
    size.width * size.height > MEDIA_COPY_MAX_PIXELS
  );
}

export async function fetchExternalImage(
  url: string,
  deps: FetchImageDeps = {}
): Promise<ImageFetchResult> {
  const maxBytes = deps.maxBytes ?? MEDIA_COPY_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? TIMEOUT_MS
  );
  try {
    const opened = await openGuardedMedia(url, {
      signal: controller.signal,
      accept: COPIED_IMAGE_ACCEPT,
      maxBytes,
      fetch: deps.fetch,
      validate: deps.validate,
    });
    if (!opened.ok) return opened;
    const res = opened.res;

    const streamed = await readImageCapped(res, maxBytes);
    if (!streamed.ok) {
      if (controller.signal.aborted && streamed.reason === "fetch_failed")
        return { ok: false, reason: "timeout" };
      return streamed;
    }
    const size = sniffImageSize(streamed.bytes, streamed.mime);
    if (size && exceedsImageBounds(size)) {
      return { ok: false, reason: "too_large" };
    }
    return {
      ok: true,
      bytes: streamed.bytes,
      mime: streamed.mime,
      ...(size ?? {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THE guarded open every remote-media download goes through (images here,
 * videos in `fetch-video.ts`): the URL is vetted (`validateExternalUrl`), the
 * request goes through `safePublicFetch` (every redirect hop re-resolved,
 * refused on any non-public address, socket pinned), a non-2xx status maps to
 * a typed reason, and a truthful `Content-Length` over `maxBytes` is refused
 * before a byte is read. The caller reads the body (capped, sniffed) and owns
 * the abort signal (its timeouts). Never throws.
 */
export async function openGuardedMedia(
  url: string,
  opts: {
    signal: AbortSignal;
    accept: string;
    maxBytes: number;
    fetch?: FetchImageDeps["fetch"];
    validate?: FetchImageDeps["validate"];
  }
): Promise<
  { ok: true; res: Response } | { ok: false; reason: ImageFetchFailure }
> {
  const validate = opts.validate ?? validateExternalUrl;
  const fetchImpl = opts.fetch ?? safePublicFetch;
  if (!validate(url).valid) return { ok: false, reason: "blocked" };
  let res: Response;
  try {
    res = await fetchImpl(
      url,
      {
        method: "GET",
        signal: opts.signal,
        headers: { Accept: opts.accept, "User-Agent": "SynapMediaCopy/1.0" },
      },
      REDIRECT_HOPS
    );
  } catch (err) {
    if (opts.signal.aborted) return { ok: false, reason: "timeout" };
    // safePublicFetch throws "Blocked outbound request" on a refused hop.
    return {
      ok: false,
      reason:
        err instanceof Error && /^Blocked outbound request/.test(err.message)
          ? "blocked"
          : "fetch_failed",
    };
  }
  if (!res.ok) {
    await cancel(res);
    return {
      ok: false,
      reason:
        res.status >= 500
          ? "http_5xx"
          : res.status === 408 || res.status === 429
            ? "http_retry_later"
            : res.status === 403 || res.status === 404 || res.status === 410
              ? "expired"
              : "http_4xx",
    };
  }
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await cancel(res);
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, res };
}

/**
 * THE capped body reader of a guarded download: chunk by chunk, stopping the
 * moment the total passes `maxBytes` (never `arrayBuffer()` on an unbounded
 * stream). `head`, when given, judges the first `bytes` as soon as they
 * arrive — `false` stops the download (`rejected`).
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number,
  head?: { bytes: number; accept: (head: Buffer) => boolean }
): Promise<
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "too_large" | "empty" | "fetch_failed" | "rejected" }
> {
  if (!res.body) return { ok: false, reason: "empty" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let judged = !head;
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch {
        return { ok: false, reason: "fetch_failed" };
      }
      if (step.done) break;
      const value = step.value;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) return { ok: false, reason: "too_large" };
      chunks.push(value);
      if (!judged && head && total >= head.bytes) {
        judged = true;
        if (!head.accept(Buffer.concat(chunks).subarray(0, head.bytes))) {
          return { ok: false, reason: "rejected" };
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
  if (total === 0) return { ok: false, reason: "empty" };
  return { ok: true, bytes: Buffer.concat(chunks) };
}

/**
 * Read the body capped: sniff once the head has arrived (stop on a
 * non-image), stop the moment the total passes `maxBytes`.
 */
async function readImageCapped(
  res: Response,
  maxBytes: number
): Promise<
  | { ok: true; bytes: Buffer; mime: CopiedImageMime }
  | { ok: false; reason: ImageFetchFailure }
> {
  let mime: CopiedImageMime | null = null;
  const read = await readBodyCapped(res, maxBytes, {
    bytes: SNIFF_HEAD_BYTES,
    accept: (head) => (mime = sniffImageType(head)) !== null,
  });
  if (!read.ok) {
    return {
      ok: false,
      reason: read.reason === "rejected" ? "not_image" : read.reason,
    };
  }
  // A body shorter than the sniff head still gets judged.
  const judged: CopiedImageMime | null = mime ?? sniffImageType(read.bytes);
  if (!judged) return { ok: false, reason: "not_image" };
  return { ok: true, bytes: read.bytes, mime: judged };
}

/**
 * Any remote FILE's bytes through the same guarded door (validate +
 * `safePublicFetch`, `Content-Length` pre-check, capped streamed read,
 * timeout). No type sniff — the caller decides what the bytes are (e.g. an
 * inbound attachment keeps the sender's declared type). Never throws.
 */
export async function fetchGuardedBytes(
  url: string,
  opts: {
    maxBytes: number;
    timeoutMs: number;
    accept?: string;
    fetch?: FetchImageDeps["fetch"];
    validate?: FetchImageDeps["validate"];
  }
): Promise<
  | { ok: true; bytes: Buffer; contentType: string | null }
  | { ok: false; reason: ImageFetchFailure }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const opened = await openGuardedMedia(url, {
      signal: controller.signal,
      accept: opts.accept ?? "*/*",
      maxBytes: opts.maxBytes,
      fetch: opts.fetch,
      validate: opts.validate,
    });
    if (!opened.ok) return opened;
    const read = await readBodyCapped(opened.res, opts.maxBytes);
    if (!read.ok) {
      if (controller.signal.aborted && read.reason === "fetch_failed") {
        return { ok: false, reason: "timeout" };
      }
      return {
        ok: false,
        reason: read.reason === "rejected" ? "fetch_failed" : read.reason,
      };
    }
    return {
      ok: true,
      bytes: read.bytes,
      contentType: opened.res.headers.get("content-type"),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function cancel(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
}
