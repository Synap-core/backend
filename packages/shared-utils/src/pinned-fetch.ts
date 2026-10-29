/**
 * safePublicFetch: THE door for a server-side request to a URL that a person,
 * an agent, an automation or content supplied. There is no other one (the
 * hostname-only `safeExternalFetch` was folded into this door; tripwire
 * `outbound-fetch-door.tripwire.test.ts`).
 *
 * `validateExternalUrl` reads the URL text only: `http://evil.example/` whose
 * name resolves to `169.254.169.254` (or `10.0.0.5`, `::1`, a Docker service
 * such as Kratos admin) passes it. This door, on EVERY hop (the first URL and
 * each redirect):
 *   1. runs `validateExternalUrl` (scheme, port, literal IP, hostname);
 *   2. resolves the hostname to ALL its addresses and refuses the hop when ANY
 *      is not public (loopback, private, link-local, CGNAT, metadata,
 *      multicast, reserved, documentation, IPv4-mapped/NAT64 of those);
 *   3. connects to the address it vetted (the socket's `lookup` is pinned to
 *      it), so a second resolution at connect time cannot swap in another IP.
 *      TLS still verifies the certificate against the hostname.
 *
 * Built on `node:http(s)` (whose `lookup` option is the pin) rather than a new
 * dependency; the answer is a WHATWG `Response` so callers read it like fetch.
 * No content decoding: no `Accept-Encoding` is sent (a caller's is dropped),
 * so servers answer identity bytes.
 *
 * An endpoint the OPERATOR configured (an env var, the intelligence service on
 * the Docker network) is not a URL from content and does not come through here.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import { Readable, pipeline } from "node:stream";
import {
  BlockedOutboundError,
  isPublicAddress,
  validateExternalUrl,
  WEB_PORTS,
} from "./validate-url.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a hostname resolves to. */
export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafePublicFetchInit {
  method?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  /**
   * Request body. A string or bytes is sent as is, with a `Content-Length`.
   * A byte stream (multipart file parts read from storage) is sent chunked,
   * never held whole in memory; it can be sent once, so a redirect answered
   * to a streamed request is refused.
   */
  body?: string | Uint8Array | AsyncIterable<Uint8Array> | null;
  signal?: AbortSignal;
}

export interface SafePublicFetchDeps {
  resolve?: AddressResolver;
  /** Which addresses may be connected to. Default: {@link isPublicAddress}. */
  isAllowedAddress?: (address: string) => boolean;
  /**
   * Which ports a hop may name. Default: the scheme's own (80, 443) — a
   * content URL has no business reaching a public host's admin or database
   * port. `"any"` lifts it, for a destination a person approved by name (a
   * registered service, a skill's approved host, a vault tool's base URL) and
   * for tests against an ephemeral local server. The address is vetted
   * either way.
   */
  allowedPorts?: ReadonlySet<number> | "any";
}

const systemResolver: AddressResolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));
};

function blocked(reason: string): Error {
  return new BlockedOutboundError(reason);
}

/** Resolve + vet every address; the one to connect to. */
async function vetHost(
  hostname: string,
  resolve: AddressResolver,
  allowed: (address: string) => boolean,
  signal?: AbortSignal
): Promise<ResolvedAddress> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(bare);
  const addresses: ResolvedAddress[] = literal
    ? [{ address: bare, family: literal === 6 ? 6 : 4 }]
    : await abortable(resolve(bare), signal);
  if (addresses.length === 0) throw blocked(`'${bare}' did not resolve`);
  const refused = addresses.find((a) => !allowed(a.address));
  if (refused) {
    throw blocked(
      `'${bare}' resolves to a private or reserved address (${refused.address})`
    );
  }
  return addresses[0]!;
}

/** A resolution the caller's signal can cut short (DNS has no timeout of ours). */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

function pinnedLookup(pin: ResolvedAddress): LookupFunction {
  return ((
    _host: string,
    opts: { all?: boolean },
    cb: (...args: unknown[]) => void
  ) => {
    if (opts?.all) cb(null, [{ address: pin.address, family: pin.family }]);
    else cb(null, pin.address, pin.family);
  }) as unknown as LookupFunction;
}

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function requestOnce(
  url: URL,
  pin: ResolvedAddress,
  init: SafePublicFetchInit
): Promise<http.IncomingMessage> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  // Identity bytes only: the answer is handed back undecoded.
  delete headers["accept-encoding"];
  // The door sets the length of what it sends; a caller's is never trusted.
  delete headers["content-length"];
  const stream = isStreamedBody(init.body) ? init.body : undefined;
  const body =
    init.body === undefined || init.body === null || stream
      ? undefined
      : typeof init.body === "string"
        ? Buffer.from(init.body)
        : Buffer.from(
            (init.body as Uint8Array).buffer,
            (init.body as Uint8Array).byteOffset,
            (init.body as Uint8Array).byteLength
          );
  if (body) headers["content-length"] = String(body.byteLength);
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: init.method ?? "GET",
      headers,
      lookup: pinnedLookup(pin),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    req.once("response", resolve);
    req.once("error", reject);
    if (stream) {
      // No Content-Length: node sends it chunked. A source that fails (a file
      // gone, over its cap) destroys the request, and the caller reads the
      // source's own failure.
      pipeline(Readable.from(stream), req, (err) => {
        if (err) {
          req.destroy(err);
          reject(err);
        }
      });
    } else {
      req.end(body);
    }
  });
}

function isStreamedBody(
  body: SafePublicFetchInit["body"]
): body is AsyncIterable<Uint8Array> {
  return (
    typeof body === "object" &&
    body !== null &&
    !(body instanceof Uint8Array) &&
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
      "function"
  );
}

function toResponse(res: http.IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 502;
  const headers = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else if (typeof v === "string") headers.set(k, v);
  }
  const nullBody =
    NULL_BODY_STATUSES.has(status) || method.toUpperCase() === "HEAD";
  if (nullBody) res.resume();
  return new Response(
    nullBody ? null : (Readable.toWeb(res) as unknown as ReadableStream),
    { status, statusText: res.statusMessage ?? "", headers }
  );
}

/**
 * Redirect hops a public READ follows (a page, an API, a media file): http →
 * https, a locale, a slug, a CDN hop. Shared by the web reader and the media
 * copy so one policy change lands once.
 */
export const PUBLIC_FETCH_REDIRECT_HOPS = 3;

/**
 * Fetch a URL that came from content. Redirects are followed manually up to
 * `maxRedirects` (default 0 — refused), every hop re-vetted and re-pinned.
 * Throws a `BlockedOutboundError` (`isBlockedOutboundError`) on a refused hop.
 */
export async function safePublicFetch(
  rawUrl: string,
  init: SafePublicFetchInit = {},
  maxRedirects = 0,
  deps: SafePublicFetchDeps = {}
): Promise<Response> {
  const resolve = deps.resolve ?? systemResolver;
  const allowed = deps.isAllowedAddress ?? isPublicAddress;
  const ports = deps.allowedPorts ?? WEB_PORTS;
  const method = init.method ?? "GET";
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = validateExternalUrl(currentUrl, { allowedPorts: ports });
    if (!check.valid) throw blocked(check.reason);
    const pin = await vetHost(
      check.url.hostname,
      resolve,
      allowed,
      init.signal
    );
    const res = await requestOnce(check.url, pin, init);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status < 300 || status >= 400 || !location) {
      return toResponse(res, method);
    }
    res.resume();
    if (isStreamedBody(init.body)) {
      throw blocked("a redirect cannot resend a streamed request body");
    }
    currentUrl = new URL(location, check.url).toString();
  }
  throw blocked("too many redirects");
}
