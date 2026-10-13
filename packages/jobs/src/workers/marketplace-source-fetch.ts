/**
 * Marketplace source fetches — the ONLY way the pod talks to a third-party
 * source. Every request here is an anonymous GET:
 *   - no cookies, no Authorization, no pod key, no relay token — the request
 *     carries nothing but `Accept`, so a source learns that a pod asked and
 *     nothing about who it is;
 *   - https only, and redirects are refused (a redirect could point the pod
 *     at an address the person never chose — an internal one included);
 *   - a definition is fetched only from the index's OWN origin, so a signed
 *     index cannot steer the pod at any other host;
 *   - only PUBLIC addresses are reached: the host is resolved at connect time
 *     and refused when any address it resolves to is loopback, private,
 *     link-local, CGNAT or unique-local (`isNonPublicAddress`) — checked on
 *     the address the socket actually connects to, so a name that re-resolves
 *     to an internal address between a check and the connect (DNS rebinding)
 *     is refused too;
 *   - every body is read through a byte cap and dropped past it.
 *
 * The verdicts on what comes back live in `marketplace-source-verify.ts`.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  MARKETPLACE_INDEX_FILE,
  MARKETPLACE_INDEX_MAX_BYTES,
  MARKETPLACE_SIGNATURE_MAX_BYTES,
  MARKETPLACE_SIGNATURE_SUFFIX,
} from "@synap-core/types/marketplace-source";

/** The fetch signature the pod uses; tests inject their own. */
export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 8000;

/**
 * Every address a source fetch may NOT connect to. IPv4: "this network"
 * 0/8, RFC 1918 (10/8, 172.16/12, 192.168/16), CGNAT 100.64/10, loopback
 * 127/8, link-local 169.254/16 (cloud metadata), IETF/benchmark/test nets,
 * multicast and reserved. IPv6: unspecified, loopback, unique-local
 * fc00::/7, link-local fe80::/10 and multicast. An IPv4-mapped IPv6 address
 * (`::ffff:127.0.0.1`) is checked against the IPv4 rules by `BlockList`
 * itself, so an internal v4 address cannot hide behind it.
 */
const NON_PUBLIC = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    list.addSubnet(net, prefix, "ipv4");
  }
  for (const [net, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ] as const) {
    list.addSubnet(net, prefix, "ipv6");
  }
  return list;
})();

/**
 * Is `address` one a source fetch must never reach? Pure. Anything that is
 * not an IP address at all counts as non-public — closed, never a guess.
 */
export function isNonPublicAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 0) return true;
  return NON_PUBLIC.check(bare, family === 4 ? "ipv4" : "ipv6");
}

function nonPublicError(host: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`${host} is not a public address, so the pod did not reach it.`),
    { code: "ENOTPUBLIC" }
  );
}

/**
 * The DNS lookup every source socket connects through: resolve every
 * address, refuse the host if ANY is non-public (an attacker who controls
 * one record controls which one is tried), else hand them to the connect.
 */
export const publicOnlyLookup: LookupFunction = (
  hostname,
  options,
  callback
) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    const list = (addresses ?? []) as LookupAddress[];
    if (err) return callback(err, "", 4);
    if (list.length === 0 || list.some((a) => isNonPublicAddress(a.address))) {
      return callback(nonPublicError(hostname), "", 4);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

/**
 * The fetch every source request goes through by default: an anonymous
 * https GET whose socket can only reach a public address (`publicOnlyLookup`;
 * an IP-literal host is checked directly, as no lookup runs for it). A
 * redirect is refused, never followed — the `redirect: "error"` rule.
 */
export const publicOnlyFetch: SourceFetch = (url, init) =>
  new Promise<Response>((resolve, reject) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch (err) {
      return reject(err);
    }
    if (target.protocol !== "https:") {
      return reject(new Error("A source is fetched over https only."));
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0 && isNonPublicAddress(host)) {
      return reject(nonPublicError(host));
    }
    const req = httpsRequest(
      target,
      {
        method: "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        lookup: publicOnlyLookup,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return reject(new Error("The source answered with a redirect."));
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) headers.append(key, v);
          } else if (value !== undefined) {
            headers.set(key, value);
          }
        }
        const empty = status === 204 || status === 205 || status === 304;
        if (empty) res.resume();
        resolve(
          new Response(
            empty
              ? null
              : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>),
            { status, statusText: res.statusMessage, headers }
          )
        );
      }
    );
    req.on("error", reject);
    req.end();
  });

/** The exact request init every source fetch uses — nothing pod-identifying. */
export function anonymousGetInit(): RequestInit {
  return {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
}

/**
 * The index URL for what a person typed: an address ending in `.json` IS the
 * index; anything else is a base the index sits under. Null when it is not an
 * https address.
 */
export function indexUrlFor(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith(".json")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${MARKETPLACE_INDEX_FILE}`;
  }
  return url.toString();
}

/**
 * Resolve a package's `definitionUrl` against its index. Null unless it is
 * https on the index's own origin.
 */
export function resolveDefinitionUrl(
  indexUrl: string,
  definitionUrl: string
): string | null {
  try {
    const base = new URL(indexUrl);
    const url = new URL(definitionUrl, base);
    if (url.protocol !== "https:" || url.origin !== base.origin) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export type CappedRead =
  { ok: true; bytes: Uint8Array } | { ok: false; tooLarge: true };

/** Read a body, giving up (and cancelling the stream) past `max` bytes. */
export async function readCapped(
  res: Response,
  max: number
): Promise<CappedRead> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, tooLarge: true };
  }
  if (!res.body) return { ok: true, bytes: new Uint8Array(0) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export type IndexFetch =
  | {
      ok: true;
      indexUrl: string;
      indexBytes: Uint8Array;
      /** The `.sig` body; null when the source serves none (404). */
      signature: string | null;
    }
  | {
      ok: false;
      reason: "bad_address" | "unreachable" | "too_large";
      message: string;
    };

async function get(
  url: string,
  fetchImpl: SourceFetch
): Promise<Response | null> {
  try {
    return await fetchImpl(url, anonymousGetInit());
  } catch {
    return null;
  }
}

/** Fetch a source's index and its detached signature. Never throws. */
export async function fetchSourceIndex(
  address: string,
  fetchImpl: SourceFetch = publicOnlyFetch
): Promise<IndexFetch> {
  const indexUrl = indexUrlFor(address);
  if (!indexUrl) {
    return {
      ok: false,
      reason: "bad_address",
      message: "A source address is an https:// address.",
    };
  }
  const res = await get(indexUrl, fetchImpl);
  if (!res) {
    return {
      ok: false,
      reason: "unreachable",
      message: `The pod couldn't reach ${new URL(indexUrl).host}.`,
    };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      reason: "unreachable",
      message:
        res.status === 404
          ? `There is no ${MARKETPLACE_INDEX_FILE} at that address.`
          : `The source answered ${res.status}.`,
    };
  }
  const body = await readCapped(res, MARKETPLACE_INDEX_MAX_BYTES);
  if (!body.ok) {
    return {
      ok: false,
      reason: "too_large",
      message: `The index is larger than ${MARKETPLACE_INDEX_MAX_BYTES / 1024 / 1024} MB, so the pod did not read it.`,
    };
  }

  const sigRes = await get(
    `${indexUrl}${MARKETPLACE_SIGNATURE_SUFFIX}`,
    fetchImpl
  );
  if (!sigRes) {
    return {
      ok: false,
      reason: "unreachable",
      message: "The pod couldn't fetch the index signature.",
    };
  }
  let signature: string | null = null;
  if (sigRes.status === 404) {
    await sigRes.body?.cancel().catch(() => undefined);
  } else if (!sigRes.ok) {
    await sigRes.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      reason: "unreachable",
      message: `The source answered ${sigRes.status} for the index signature.`,
    };
  } else {
    const sig = await readCapped(sigRes, MARKETPLACE_SIGNATURE_MAX_BYTES);
    // An oversized signature is no signature: the verifier then refuses it.
    signature = sig.ok ? new TextDecoder().decode(sig.bytes) : "";
  }
  return { ok: true, indexUrl, indexBytes: body.bytes, signature };
}

export type DefinitionFetch =
  { ok: true; bytes: Uint8Array } | { ok: false; message: string };

/** Fetch one definition's bytes (the caller verifies the digest). Never throws. */
export async function fetchDefinitionBytes(
  url: string,
  maxBytes: number,
  fetchImpl: SourceFetch = publicOnlyFetch
): Promise<DefinitionFetch> {
  const res = await get(url, fetchImpl);
  if (!res) {
    return {
      ok: false,
      message: `The pod couldn't reach ${new URL(url).host}.`,
    };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return {
      ok: false,
      message: `The source answered ${res.status} for the definition.`,
    };
  }
  const body = await readCapped(res, maxBytes);
  if (!body.ok) {
    return {
      ok: false,
      message: `The definition is larger than ${Math.round(maxBytes / 1024)} KB.`,
    };
  }
  return { ok: true, bytes: body.bytes };
}
