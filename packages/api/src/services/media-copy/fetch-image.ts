/**
 * Fetch ONE external image for the media-copy job: SSRF-guarded, streamed under
 * a hard byte cap and a timeout, and accepted only when the bytes themselves
 * prove an allowed raster type.
 *
 *   • guard   → `validateExternalUrl` + `safeExternalFetch` (every redirect hop
 *               re-validated) — the same door as the capture reader. Its known
 *               limit applies here too: it matches hostnames, it does not
 *               resolve them, so DNS rebinding is NOT mitigated.
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
  safeExternalFetch,
  validateExternalUrl,
  type ValidateUrlResult,
} from "@synap/shared-utils";
import {
  SNIFF_HEAD_BYTES,
  sniffImageSize,
  sniffImageType,
  type CopiedImageMime,
} from "./image-sniff.js";

/** Decision 7: images up to 25 MB. */
export const MEDIA_COPY_MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const REDIRECT_HOPS = 3;

export type ImageFetchFailure =
  | "blocked"
  | "http_4xx"
  | "http_5xx"
  | "too_large"
  | "not_image"
  | "empty"
  | "timeout"
  | "fetch_failed";

/** Reasons a retry cannot change — recorded once, never fetched again. */
export const PERMANENT_FETCH_FAILURES: ReadonlySet<ImageFetchFailure> = new Set(
  ["blocked", "http_4xx", "too_large", "not_image", "empty"]
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
    init?: RequestInit,
    maxRedirects?: number
  ) => Promise<Response>;
  validate?: (raw: string) => ValidateUrlResult;
  maxBytes?: number;
  timeoutMs?: number;
}

export async function fetchExternalImage(
  url: string,
  deps: FetchImageDeps = {}
): Promise<ImageFetchResult> {
  const validate = deps.validate ?? validateExternalUrl;
  const fetchImpl = deps.fetch ?? safeExternalFetch;
  const maxBytes = deps.maxBytes ?? MEDIA_COPY_MAX_BYTES;

  if (!validate(url).valid) return { ok: false, reason: "blocked" };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? TIMEOUT_MS
  );
  try {
    let res: Response;
    try {
      res = await fetchImpl(
        url,
        {
          method: "GET",
          signal: controller.signal,
          headers: {
            Accept: "image/png,image/jpeg,image/gif,image/webp;q=0.9",
            "User-Agent": "SynapMediaCopy/1.0",
          },
        },
        REDIRECT_HOPS
      );
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, reason: "timeout" };
      // safeExternalFetch throws "Blocked outbound request" on a bad hop.
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
        reason: res.status >= 500 ? "http_5xx" : "http_4xx",
      };
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await cancel(res);
      return { ok: false, reason: "too_large" };
    }

    const streamed = await readImageCapped(res, maxBytes);
    if (!streamed.ok) {
      if (controller.signal.aborted && streamed.reason === "fetch_failed")
        return { ok: false, reason: "timeout" };
      return streamed;
    }
    const size = sniffImageSize(streamed.bytes, streamed.mime);
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
 * Read the body chunk by chunk: sniff once the head has arrived (stop on a
 * non-image), stop the moment the total passes `maxBytes`.
 */
async function readImageCapped(
  res: Response,
  maxBytes: number
): Promise<
  | { ok: true; bytes: Buffer; mime: CopiedImageMime }
  | { ok: false; reason: ImageFetchFailure }
> {
  if (!res.body) return { ok: false, reason: "empty" };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let mime: CopiedImageMime | null = null;
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
      if (!mime && total >= SNIFF_HEAD_BYTES) {
        mime = sniffImageType(
          Buffer.concat(chunks).subarray(0, SNIFF_HEAD_BYTES)
        );
        if (!mime) return { ok: false, reason: "not_image" };
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
  const bytes = Buffer.concat(chunks);
  // A body shorter than the sniff head still gets judged.
  mime = mime ?? sniffImageType(bytes);
  if (!mime) return { ok: false, reason: "not_image" };
  return { ok: true, bytes, mime };
}

async function cancel(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing to release
  }
}
