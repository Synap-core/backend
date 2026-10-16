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
  openGuardedMedia,
  readBodyCapped,
  type GuardedFetchDeps,
  type RemoteFetchFailure,
} from "./remote-fetch.js";
import {
  COPIED_IMAGE_ACCEPT,
  SNIFF_HEAD_BYTES,
  sniffImageSize,
  sniffImageType,
  type CopiedImageMime,
} from "./image-sniff.js";

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

/** Why an image was not fetched: the guarded door's reasons, or not an image. */
export type ImageFetchFailure = RemoteFetchFailure | "not_image";

export type ImageFetchResult =
  | {
      ok: true;
      bytes: Buffer;
      mime: CopiedImageMime;
      width?: number;
      height?: number;
    }
  | { ok: false; reason: ImageFetchFailure };

export interface FetchImageDeps extends GuardedFetchDeps {
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
