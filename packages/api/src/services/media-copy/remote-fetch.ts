/**
 * THE guarded remote-file download every media copy goes through — images
 * (`fetch-image.ts`), videos (`fetch-video.ts`), inbound message attachments
 * (`connectors/ingest-inbound-attachments.ts`): the SSRF guard on every hop
 * (`validateExternalUrl` + `safePublicFetch`, DNS-pinned), a typed failure
 * for every non-2xx, a truthful `Content-Length` refused over the cap, and a
 * capped streamed body read. Neutral: no type sniff here — each caller judges
 * what the bytes are. Never throws.
 *
 * WHY THE WEB READER HAS ITS OWN BODY READER (`web-read/fetch.ts` `webGet`):
 * a page past its cap is still a page — the reader keeps the first bytes,
 * decodes them in the page's charset as they stream and says `truncated`;
 * a media file past its cap is corrupt — this door REFUSES it (`too_large`).
 * Different contracts, so two readers; the policy that must not differ is
 * shared: the typed SSRF refusal (`isBlockedOutboundError`) and the redirect
 * budget (`PUBLIC_FETCH_REDIRECT_HOPS`), both from `@synap/shared-utils`.
 */

import {
  isBlockedOutboundError,
  PUBLIC_FETCH_REDIRECT_HOPS,
  safePublicFetch,
  validateExternalUrl,
  type SafePublicFetchInit,
  type ValidateUrlResult,
} from "@synap/shared-utils";
import { PERMANENT_LIBRARY_MEDIA_FAILURES } from "@synap-core/types/imports";

/** Why a guarded download did not deliver bytes (no type judgement here). */
export type RemoteFetchFailure =
  | "blocked"
  /** 403 / 404 / 410: the link no longer serves the file (an expired CDN signature). */
  | "expired"
  | "http_4xx"
  /** 408 Request Timeout / 429 Too Many Requests: the server says "later". */
  | "http_retry_later"
  | "http_5xx"
  | "too_large"
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

/** Test seams of the door (default: the real guard and pinned fetch). */
export interface GuardedFetchDeps {
  fetch?: (
    url: string,
    init?: SafePublicFetchInit,
    maxRedirects?: number
  ) => Promise<Response>;
  validate?: (raw: string) => ValidateUrlResult;
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
    fetch?: GuardedFetchDeps["fetch"];
    validate?: GuardedFetchDeps["validate"];
  }
): Promise<
  { ok: true; res: Response } | { ok: false; reason: RemoteFetchFailure }
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
      PUBLIC_FETCH_REDIRECT_HOPS
    );
  } catch (err) {
    if (opts.signal.aborted) return { ok: false, reason: "timeout" };
    // A refused hop is a TYPED error from the door, never a message match.
    return {
      ok: false,
      reason: isBlockedOutboundError(err) ? "blocked" : "fetch_failed",
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
    fetch?: GuardedFetchDeps["fetch"];
    validate?: GuardedFetchDeps["validate"];
  }
): Promise<
  | { ok: true; bytes: Buffer; contentType: string | null }
  | { ok: false; reason: RemoteFetchFailure }
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
