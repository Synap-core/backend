/**
 * The built-in reader's ONE way onto the network.
 *
 * Every request — the page itself and every site adapter's API call — goes
 * through `validateExternalUrl` and then `safePublicFetch` (DNS-pinned SSRF
 * guard, every redirect hop re-vetted, web ports only). No cookies, no
 * credentials, a timeout and a byte cap on every body. A failure is a value
 * (`ok: false` with what happened), never a throw — callers turn it into an
 * honest `blocked` / `failed` read.
 */

import {
  safePublicFetch,
  validateExternalUrl,
  type SafePublicFetchInit,
} from "@synap/shared-utils";

export const WEB_READ_TIMEOUT_MS = 10_000;
/** Public pages and short links redirect (http→https, locale, slug). */
export const WEB_READ_REDIRECT_HOPS = 3;
export { WEB_READ_PAGE_BYTES_MAX } from "./limits.js";
/** Bytes of one API answer read at most. */
export const WEB_READ_API_BYTES_MAX = 1_000_000;
/** Bytes of a non-2xx body kept — enough to recognise a challenge page. */
const ERROR_BODY_BYTES_MAX = 64_000;

/**
 * Identifies the reader honestly (Wikimedia's API policy asks for a contact
 * URL). Never a browser string: the pod does not pretend to be a person.
 */
export const WEB_READ_USER_AGENT =
  "SynapPublicReader/1.0 (+https://synap.live)";

/** `safePublicFetch`'s shape — tests inject a recorded-response fake. */
export type WebFetcher = (
  url: string,
  init: SafePublicFetchInit,
  maxRedirects: number
) => Promise<Response>;

export interface WebGetOptions {
  accept?: string;
  maxBytes?: number;
  timeoutMs?: number;
  redirects?: number;
  headers?: Record<string, string>;
}

export type WebGetResult =
  | {
      ok: true;
      status: number;
      contentType: string;
      body: string;
      /** the byte cap cut the body */
      truncated: boolean;
    }
  /** The SSRF guard refused a hop (private address, odd port, bad scheme). */
  | { ok: false; kind: "refused"; detail: string }
  /** The server answered, but not 2xx. `body` is capped small. */
  | {
      ok: false;
      kind: "http";
      status: number;
      contentType: string;
      body: string;
      retryAfter?: string;
    }
  /** No answer: DNS, connection, TLS, timeout, too many redirects. */
  | { ok: false; kind: "network"; detail: string };

export interface WebGetDeps {
  fetch?: WebFetcher;
  signal?: AbortSignal;
}

function charsetOf(contentType: string): string {
  const m = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType);
  return m?.[1]?.toLowerCase() ?? "utf-8";
}

function decoderFor(contentType: string): TextDecoder {
  try {
    return new TextDecoder(charsetOf(contentType));
  } catch {
    return new TextDecoder("utf-8"); // unknown charset label: read as UTF-8
  }
}

async function readBody(
  res: Response,
  maxBytes: number,
  contentType: string
): Promise<{ body: string; truncated: boolean }> {
  const decoder = decoderFor(contentType);
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      body: decoder.decode(buf.subarray(0, maxBytes)),
      truncated: buf.byteLength > maxBytes,
    };
  }
  const reader = res.body.getReader();
  let out = "";
  let bytes = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const room = maxBytes - bytes;
      if (value.byteLength > room) {
        out += decoder.decode(value.subarray(0, room), { stream: true });
        truncated = true;
        break;
      }
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // the stream may already be closed
    }
  }
  return { body: out, truncated };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GET one public URL through the SSRF door. Never throws. */
export async function webGet(
  url: string,
  opts: WebGetOptions = {},
  deps: WebGetDeps = {}
): Promise<WebGetResult> {
  const check = validateExternalUrl(url);
  if (!check.valid) return { ok: false, kind: "refused", detail: check.reason };

  const fetchImpl: WebFetcher = deps.fetch ?? safePublicFetch;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? WEB_READ_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  deps.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetchImpl(
      check.url.toString(),
      {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: opts.accept ?? "*/*",
          "User-Agent": WEB_READ_USER_AGENT,
          ...opts.headers,
        },
      },
      opts.redirects ?? WEB_READ_REDIRECT_HOPS
    );
    const contentType = res.headers.get("content-type") ?? "";
    if (res.status < 200 || res.status >= 300) {
      const { body } = await readBody(res, ERROR_BODY_BYTES_MAX, contentType);
      const retryAfter = res.headers.get("retry-after") ?? undefined;
      return {
        ok: false,
        kind: "http",
        status: res.status,
        contentType,
        body,
        ...(retryAfter ? { retryAfter } : {}),
      };
    }
    const { body, truncated } = await readBody(
      res,
      opts.maxBytes ?? WEB_READ_API_BYTES_MAX,
      contentType
    );
    return { ok: true, status: res.status, contentType, body, truncated };
  } catch (err) {
    const detail = errorText(err);
    if (detail.startsWith("Blocked outbound request")) {
      return { ok: false, kind: "refused", detail };
    }
    return {
      ok: false,
      kind: "network",
      detail: controller.signal.aborted
        ? `timed out after ${timeoutMs} ms`
        : detail,
    };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Parse a JSON body; null when it is not JSON (a value, not a throw). */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null; // the endpoint answered something that is not JSON
  }
}
