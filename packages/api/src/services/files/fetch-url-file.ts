/**
 * A file's bytes from a URL, fetched BY THE POD — so an agent with no disk can
 * keep a generated image as a pod file.
 *
 * THE DEFECT (agent report 630ff4f7, 17-18 Nov 2026): `fal_generate_image`
 * returns image URLs; `unipile_publish_post` takes pod FILE ids. An agent on
 * the claude.ai connector has no disk and no `synap_request_upload`, so its only
 * way in was pasting ~150 KB of base64 into `synap_store_file`. This is the
 * `sourceUrl` half of that one store door: the bytes then go through the SAME
 * guards and governed create as inline content.
 *
 * GUARDS, all on the shared remote-bytes door (`fetchGuardedBytes`, media-copy):
 *   - https only, on the first URL AND every redirect (`httpsOnly`);
 *   - every hop's name resolved and refused when any address is private,
 *     loopback, link-local or metadata, the socket pinned to the vetted address
 *     (`safePublicFetch`), at most `PUBLIC_FETCH_REDIRECT_HOPS` redirects;
 *   - a size cap (a truthful Content-Length refused before a byte is read, the
 *     stream cut the moment it passes) and a timeout;
 *   - a content-type check: the served type must be one the store accepts, and
 *     must match the type the caller declared.
 * Never throws: every refusal is a sentence the caller can act on.
 */

import { safePublicFetch, type SafePublicFetchInit } from "@synap/shared-utils";
import {
  fetchGuardedBytes,
  type GuardedFetchDeps,
  type RemoteFetchFailure,
} from "../media-copy/remote-fetch.js";

const TIMEOUT_MS = 30_000;

export type UrlFileResult =
  | { ok: true; bytes: Buffer; mimeType: string; filename: string }
  | { ok: false; error: string };

/** The one fetch this door makes: the pinned door, https on every hop. */
function httpsOnlyFetch(
  url: string,
  init?: SafePublicFetchInit,
  maxRedirects?: number
): Promise<Response> {
  return safePublicFetch(url, init, maxRedirects, { httpsOnly: true });
}

const FAILURE_WORDS: Record<RemoteFetchFailure, string> = {
  blocked:
    "the URL is not allowed (only public https addresses, also after a redirect)",
  expired: "the URL no longer serves the file (403, 404 or 410)",
  http_4xx: "the server refused the request",
  http_retry_later: "the server asked to try later",
  http_5xx: "the server failed",
  too_large: "the file is larger than the store accepts",
  empty: "the URL served no bytes",
  timeout: "the download took too long",
  fetch_failed: "the download failed",
};

/** `image/png; charset=…` → `image/png`; null when absent. */
function baseType(contentType: string | null | undefined): string | null {
  const t = contentType?.split(";")[0]?.trim().toLowerCase();
  return t ? t : null;
}

/** The last path segment of the URL, else "download". */
function filenameOf(url: URL): string {
  const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // a malformed escape: keep the raw segment
  }
  name = name.replace(/[\\/\0]/g, "").trim();
  return name || "download";
}

export async function fetchUrlFile(
  rawUrl: string,
  opts: {
    /** The type the caller declared, if any: the served type must match it. */
    mimeType?: string;
    maxBytes: number;
    /** The store's own type rule (`isAllowedMimeType`). */
    isAllowedType: (mimeType: string) => boolean;
    /** Test seam: default is the pinned door with `httpsOnly`. */
    fetch?: GuardedFetchDeps["fetch"];
  }
): Promise<UrlFileResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { ok: false, error: "sourceUrl is not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "sourceUrl must be an https URL." };
  }
  const got = await fetchGuardedBytes(url.toString(), {
    maxBytes: opts.maxBytes,
    timeoutMs: TIMEOUT_MS,
    accept: opts.mimeType || "*/*",
    fetch: opts.fetch ?? httpsOnlyFetch,
  });
  if (!got.ok) {
    return {
      ok: false,
      error: `Could not store the file from sourceUrl: ${FAILURE_WORDS[got.reason]}.`,
    };
  }
  const declared = baseType(opts.mimeType);
  const served = baseType(got.contentType);
  // A server that names no real type (absent, or the generic octet-stream)
  // leaves the caller's declared type; a server that names one must agree.
  const generic = !served || served === "application/octet-stream";
  if (declared && !generic && served !== declared) {
    return {
      ok: false,
      error: `sourceUrl serves ${served}, not the declared ${declared}.`,
    };
  }
  const mimeType = generic ? declared : served;
  if (!mimeType) {
    return {
      ok: false,
      error:
        "sourceUrl serves no content type; pass `mimeType` to say what the file is.",
    };
  }
  if (!opts.isAllowedType(mimeType)) {
    return { ok: false, error: `MIME type not allowed: ${mimeType}` };
  }
  return { ok: true, bytes: got.bytes, mimeType, filename: filenameOf(url) };
}
