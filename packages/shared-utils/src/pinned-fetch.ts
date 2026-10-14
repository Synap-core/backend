/**
 * safePublicFetch — `safeExternalFetch` that also closes DNS rebinding.
 *
 * `validateExternalUrl` matches the HOSTNAME only: `http://evil.example/` whose
 * name resolves to `169.254.169.254` (or `10.0.0.5`, or `::1`) passes it. This
 * door, on EVERY hop (the first URL and each redirect):
 *   1. runs `validateExternalUrl` (scheme + hostname patterns);
 *   2. resolves the hostname to ALL its addresses and refuses the hop when ANY
 *      is not public (loopback, private, link-local, CGNAT, metadata,
 *      multicast, reserved, documentation, IPv4-mapped/NAT64 of those);
 *   3. connects to the address it vetted — the socket's `lookup` is pinned to
 *      it — so a second resolution at connect time cannot swap in another IP.
 *      TLS still verifies the certificate against the hostname.
 *
 * Built on `node:http(s)` (whose `lookup` option is the pin) rather than a new
 * dependency; the answer is a WHATWG `Response` so callers read it like fetch.
 * No content decoding: no `Accept-Encoding` is sent, so servers answer
 * identity bytes.
 *
 * Why a separate door and not `safeExternalFetch` itself: several callers of
 * that one reach operator-configured endpoints that legitimately resolve to a
 * private address (an intelligence service on the Docker network). Fetches of
 * URLs that came from CONTENT (an image URL on an entity, a page to read) must
 * use this one.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { validateExternalUrl } from "./validate-url.js";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a hostname resolves to. */
export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafePublicFetchInit {
  method?: string;
  headers?: ConstructorParameters<typeof Headers>[0];
  signal?: AbortSignal;
}

export interface SafePublicFetchDeps {
  resolve?: AddressResolver;
  /** Which addresses may be connected to. Default: {@link isPublicAddress}. */
  isAllowedAddress?: (address: string) => boolean;
}

const BLOCKED_V4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  BLOCKED_V4.addSubnet(net, prefix, "ipv4");
}

const BLOCKED_V6 = new BlockList();
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(net, prefix, "ipv6");
}

/** The IPv4 address an IPv6 address embeds (IPv4-mapped, NAT64), if any. */
function embeddedV4(v6: string): string | undefined {
  const m =
    /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v6) ??
    /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(v6);
  if (m) return m[1];
  // Hex form (`::ffff:a9fe:a9fe`) — what `new URL` and resolvers produce.
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(
    v6
  );
  if (!hex) return undefined;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when `address` is a routable public unicast address. */
export function isPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(bare);
  if (family === 4) return !BLOCKED_V4.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(bare);
    if (v4) return isPublicAddress(v4);
    return !BLOCKED_V6.check(bare, "ipv6");
  }
  return false;
}

const systemResolver: AddressResolver = async (hostname) => {
  const all = await dnsLookup(hostname, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

function blocked(reason: string): Error {
  return new Error(`Blocked outbound request: ${reason}`);
}

/** Resolve + vet every address; the one to connect to. */
async function vetHost(
  hostname: string,
  resolve: AddressResolver,
  allowed: (address: string) => boolean
): Promise<ResolvedAddress> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const literal = isIP(bare);
  const addresses: ResolvedAddress[] = literal
    ? [{ address: bare, family: literal === 6 ? 6 : 4 }]
    : await resolve(bare);
  if (addresses.length === 0) throw blocked(`'${bare}' did not resolve`);
  const refused = addresses.find((a) => !allowed(a.address));
  if (refused) {
    throw blocked(
      `'${bare}' resolves to a private or reserved address (${refused.address})`
    );
  }
  return addresses[0]!;
}

function pinnedLookup(pin: ResolvedAddress): LookupFunction {
  return ((_host: string, opts: { all?: boolean }, cb: Function) => {
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
    req.end();
  });
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
 * Fetch a URL that came from content. Redirects are followed manually up to
 * `maxRedirects` (default 0 — refused), every hop re-vetted and re-pinned.
 * Throws `Blocked outbound request: …` on a refused hop.
 */
export async function safePublicFetch(
  rawUrl: string,
  init: SafePublicFetchInit = {},
  maxRedirects = 0,
  deps: SafePublicFetchDeps = {}
): Promise<Response> {
  const resolve = deps.resolve ?? systemResolver;
  const allowed = deps.isAllowedAddress ?? isPublicAddress;
  const method = init.method ?? "GET";
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = validateExternalUrl(currentUrl);
    if (!check.valid) throw blocked(check.reason);
    const pin = await vetHost(check.url.hostname, resolve, allowed);
    const res = await requestOnce(check.url, pin, init);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status < 300 || status >= 400 || !location) {
      return toResponse(res, method);
    }
    res.resume();
    currentUrl = new URL(location, check.url).toString();
  }
  throw blocked("too many redirects");
}
