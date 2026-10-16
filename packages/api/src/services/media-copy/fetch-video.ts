/**
 * Fetch ONE external video STRAIGHT INTO STORAGE — the same guarded open as
 * images (`openGuardedMedia`: `validateExternalUrl` + `safePublicFetch`, every
 * redirect hop re-vetted, socket pinned), but the body is never buffered:
 * chunks flow from the socket into `sink` (a storage `uploadStream`, which
 * computes the sha256 as the bytes pass) while the byte count is kept.
 *
 *   • type    → the first {@link VIDEO_SNIFF_HEAD_BYTES} are sniffed BEFORE
 *               the sink sees a byte; only MP4 / WebM pass (`sniffVideoType`).
 *               A refused head means nothing was stored.
 *   • size    → a truthful `Content-Length` over the cap is refused before a
 *               byte is read; a server that omits or lies about it is cut off
 *               the moment the streamed total passes the cap — the body
 *               iterator throws, the sink aborts (S3 multipart abort / temp
 *               file unlinked), the socket is cancelled.
 *   • time    → sized for big files: {@link VIDEO_HEADERS_TIMEOUT_MS} to get
 *               the response, {@link VIDEO_IDLE_TIMEOUT_MS} of silence between
 *               chunks, {@link VIDEO_TOTAL_TIMEOUT_MS} overall.
 *
 * Cap: `LIBRARY_MEDIA_VIDEO_MAX_BYTES` (env, bytes), default 1 GiB.
 * Never throws: every refusal is a typed reason.
 */

import { envInt } from "@synap/shared-utils";
import {
  openGuardedMedia,
  type GuardedFetchDeps,
  type RemoteFetchFailure,
} from "./remote-fetch.js";
import {
  COPIED_VIDEO_ACCEPT,
  VIDEO_SNIFF_HEAD_BYTES,
  sniffVideoType,
  type CopiedVideoMime,
} from "./video-sniff.js";

export const LIBRARY_MEDIA_VIDEO_MAX_BYTES_DEFAULT = 1024 * 1024 * 1024;
export const VIDEO_HEADERS_TIMEOUT_MS = 30_000;
export const VIDEO_IDLE_TIMEOUT_MS = 60_000;
export const VIDEO_TOTAL_TIMEOUT_MS = 30 * 60_000;

/** `documents.size` is an int4: no stored file may claim more bytes. */
const DOCUMENT_SIZE_MAX = 2_147_483_647;

/**
 * The video byte cap: `LIBRARY_MEDIA_VIDEO_MAX_BYTES` when a positive integer
 * (at most what `documents.size` can hold), else 1 GiB.
 */
export function libraryMediaVideoMaxBytes(
  env: Record<string, string | undefined> = process.env
): number {
  return envInt(env, "LIBRARY_MEDIA_VIDEO_MAX_BYTES", {
    default: LIBRARY_MEDIA_VIDEO_MAX_BYTES_DEFAULT,
    min: 1,
    max: DOCUMENT_SIZE_MAX,
  });
}

export type VideoFetchFailure =
  | RemoteFetchFailure
  | "not_video"
  /** The bytes were fine; storing them failed (`cause` says why). */
  | "store_failed";

export type VideoFetchResult<T> =
  | {
      ok: true;
      mime: CopiedVideoMime;
      bytes: number;
      stored: T;
    }
  | { ok: false; reason: VideoFetchFailure; cause?: unknown };

export interface FetchVideoDeps {
  fetch?: GuardedFetchDeps["fetch"];
  validate?: GuardedFetchDeps["validate"];
  maxBytes?: number;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
}

/**
 * Download `url` into `sink`. The sink receives an async iterable of the
 * body's chunks (head included) and the sniffed mime; if the iterable throws
 * (cap, timeout, dropped socket), the sink must reject — storage's
 * `uploadStream` does, leaving nothing behind.
 */
export async function fetchExternalVideoToSink<T>(
  url: string,
  sink: (body: AsyncIterable<Uint8Array>, mime: CopiedVideoMime) => Promise<T>,
  deps: FetchVideoDeps = {}
): Promise<VideoFetchResult<T>> {
  const maxBytes = deps.maxBytes ?? libraryMediaVideoMaxBytes();
  const idleMs = deps.idleTimeoutMs ?? VIDEO_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const abortForTime = () => {
    timedOut = true;
    controller.abort();
  };
  const total = setTimeout(
    abortForTime,
    deps.totalTimeoutMs ?? VIDEO_TOTAL_TIMEOUT_MS
  );
  let idle = setTimeout(
    abortForTime,
    deps.headersTimeoutMs ?? VIDEO_HEADERS_TIMEOUT_MS
  );
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(abortForTime, idleMs);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const opened = await openGuardedMedia(url, {
      signal: controller.signal,
      accept: COPIED_VIDEO_ACCEPT,
      maxBytes,
      fetch: deps.fetch,
      validate: deps.validate,
    });
    if (!opened.ok) return { ok: false, reason: opened.reason };
    if (!opened.res.body) return { ok: false, reason: "empty" };
    reader = opened.res.body.getReader();
    const r = reader;
    armIdle();

    // A timer's abort must end a pending read even when the body is not tied
    // to the signal: the read races the abort, never waits on a dead socket.
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error("aborted"));
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    aborted.catch(() => undefined);
    const read = async (): Promise<
      | { ok: true; chunk: Uint8Array | null }
      | { ok: false; reason: VideoFetchFailure }
    > => {
      try {
        const step = await Promise.race([r.read(), aborted]);
        armIdle();
        return { ok: true, chunk: step.done ? null : step.value };
      } catch {
        return { ok: false, reason: timedOut ? "timeout" : "fetch_failed" };
      }
    };

    // 1 — the head, sniffed before anything is stored.
    const head: Uint8Array[] = [];
    let headBytes = 0;
    let ended = false;
    while (headBytes < VIDEO_SNIFF_HEAD_BYTES) {
      const got = await read();
      if (!got.ok) return got;
      if (got.chunk === null) {
        ended = true;
        break;
      }
      if (got.chunk.byteLength === 0) continue;
      head.push(got.chunk);
      headBytes += got.chunk.byteLength;
      if (headBytes > maxBytes) return { ok: false, reason: "too_large" };
    }
    if (headBytes === 0) return { ok: false, reason: "empty" };
    const mime = sniffVideoType(
      Buffer.concat(head).subarray(0, VIDEO_SNIFF_HEAD_BYTES)
    );
    if (!mime) return { ok: false, reason: "not_video" };

    // 2 — the rest, streamed into the sink under the cap. No hash here: the
    // storage upload computes the checksum as the bytes pass (one pass).
    let bytes = 0;
    let failure: VideoFetchFailure | null = null;
    let drained = false;
    async function* body(): AsyncGenerator<Uint8Array> {
      for (const chunk of head) {
        bytes += chunk.byteLength;
        yield chunk;
      }
      if (ended) {
        drained = true;
        return;
      }
      for (;;) {
        const got = await read();
        if (!got.ok) {
          failure = got.reason;
          throw new Error(`video fetch: ${got.reason}`);
        }
        if (got.chunk === null) {
          drained = true;
          return;
        }
        if (got.chunk.byteLength === 0) continue;
        bytes += got.chunk.byteLength;
        if (bytes > maxBytes) {
          failure = "too_large";
          throw new Error("video fetch: too_large");
        }
        yield got.chunk;
      }
    }

    let stored: T;
    try {
      stored = await sink(body(), mime);
    } catch (err) {
      return failure
        ? { ok: false, reason: failure }
        : { ok: false, reason: "store_failed", cause: err };
    }
    // A sink that returned without draining the body did not store it all.
    if (failure) return { ok: false, reason: failure };
    if (!drained) {
      return {
        ok: false,
        reason: "store_failed",
        cause: new Error("the sink did not read the whole body"),
      };
    }
    return { ok: true, mime, bytes, stored };
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    if (reader) {
      try {
        await reader.cancel();
      } catch {
        // already closed
      }
    }
  }
}
