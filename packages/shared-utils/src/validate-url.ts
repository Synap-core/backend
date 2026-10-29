/**
 * validateExternalUrl
 *
 * Guards against Server-Side Request Forgery (SSRF) by rejecting URLs that
 * name private, loopback, link-local, or otherwise internal destinations.
 *
 * It reads the URL text only. To SEND a request to a URL a person, an agent
 * or content supplied, use `safePublicFetch` (`./pinned-fetch.ts`): it runs
 * this check, then resolves the name, refuses any private answer and connects
 * to the address it vetted, on every redirect hop. There is no other door.
 *
 * Lives in @synap/shared-utils so low-level packages (jobs) can reach it
 * without depending on @synap/api (which would be a circular dependency).
 *
 * Example:
 *   const check = validateExternalUrl(input.webhookUrl);
 *   if (!check.valid) throw new Error(check.reason);
 *   const res = await safePublicFetch(check.url.toString(), { method: "POST", body });
 */

import { BlockList, isIP } from "node:net";

/**
 * Hostname PATTERNS refused before any resolution. A literal IP is judged by
 * `isPublicAddress` instead (below); these catch names that embed a private
 * address (`127.0.0.1.nip.io`) or are known internal names. They are a first
 * filter, not the defence: the door that fetches (`safePublicFetch`) resolves
 * every name and refuses any private answer.
 */
const BLOCKED_NAME_PATTERNS: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^169\.254\./,
  /^100\.64\./,
  /^0\./,
  /^localhost$/i,
  /\.localhost$/i,
  /^metadata\.google\.internal$/i,
  /^host\.docker\.internal$/i,
  /\.internal$/i,
  /\.local$/i,
];

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
  ["::", 96], // IPv4-compatible (deprecated): embeds any IPv4
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215)
  ["100::", 64], // discard-only
  ["2002::", 16], // 6to4: embeds any IPv4, incl. private ones
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
  // Hex form (`::ffff:a9fe:a9fe`): what `new URL` and resolvers produce.
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

/** The ports a server-side request may name unless its caller lifts the limit. */
export const WEB_PORTS: ReadonlySet<number> = new Set([80, 443]);

export interface ValidateExternalUrlOptions {
  /**
   * Which ports the URL may name. Default {@link WEB_PORTS}: a URL that came
   * from content has no business reaching a host's admin or database port.
   * `"any"` lifts it, for a destination a person approved by name (a vault
   * tool's configured base URL, a skill's approved host, a registered service).
   */
  allowedPorts?: ReadonlySet<number> | "any";
}

export type ValidateUrlResult =
  { valid: true; url: URL } | { valid: false; reason: string };

/**
 * Scheme-only check: true when `raw` parses as an `http:`/`https:` URL.
 *
 * Unlike `validateExternalUrl`, this does NOT block loopback, private, or
 * link-local hosts — it exists for callers that store a URL for later
 * display/click-through (never a server-side fetch), where a developer must
 * be able to record `http://localhost:3000/thing`. It still rejects
 * script-capable / non-network schemes (`javascript:`, `data:`, `file:`, …).
 *
 * Never use this to guard an outbound `fetch()` — that is what
 * `validateExternalUrl`/`safePublicFetch` are for.
 *
 * DEFINED in `@synap-core/types/navigation` and re-exported here, so the rule
 * the pod stores a link by is the rule relay and the browser open it by.
 */
export { isHttpUrl } from "@synap-core/types/navigation";

/**
 * Validate that `raw` is a safe URL to fetch from server-side code.
 *
 * Returns `{ valid: true, url }` if safe, `{ valid: false, reason }` otherwise.
 * Checks the URL TEXT only: scheme, port, a literal IP (by address, so
 * `[::ffff:127.0.0.1]`, `[::]` and `0x7f.1` are judged as what they are), and
 * the hostname (a trailing dot is ignored, a single-label name such as a
 * Docker service `kratos` or `backend` is refused). It does NOT resolve the
 * name: a public name that resolves to a private address passes here. Fetch
 * through `safePublicFetch`, which runs this check AND resolves, vets and pins
 * the address on every hop.
 */
export function validateExternalUrl(
  raw: string,
  opts: ValidateExternalUrlOptions = {}
): ValidateUrlResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { valid: false, reason: "Not a valid URL" };
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return {
      valid: false,
      reason: `Protocol '${url.protocol}' is not allowed (only http/https)`,
    };
  }

  const ports = opts.allowedPorts ?? WEB_PORTS;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (ports !== "any" && !ports.has(port)) {
    return { valid: false, reason: `port ${port} is not a web port` };
  }

  // IPv6 hostnames arrive from `URL` WITH their brackets (`"[::1]"`). A
  // trailing dot makes a name absolute (`kratos.` IS `kratos` to a resolver),
  // so it is dropped before any rule sees the name.
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");

  if (!hostname) {
    return { valid: false, reason: "URL has no hostname" };
  }

  if (isIP(hostname)) {
    return isPublicAddress(hostname)
      ? { valid: true, url }
      : {
          valid: false,
          reason: `URL '${hostname}' resolves to a private or reserved address`,
        };
  }

  if (!hostname.includes(".")) {
    return {
      valid: false,
      reason: `Hostname '${hostname}' is not a public hostname`,
    };
  }

  if (BLOCKED_NAME_PATTERNS.some((re) => re.test(hostname))) {
    return { valid: false, reason: `Hostname '${hostname}' is not allowed` };
  }

  return { valid: true, url };
}

/**
 * The SSRF guard refused an outbound request (a private / reserved address,
 * a disallowed port or scheme, a redirect it may not follow). A TYPE, so a
 * caller asks `isBlockedOutboundError(err)` instead of sniffing the message;
 * the message stays `Blocked outbound request: <reason>` for logs.
 */
export class BlockedOutboundError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Blocked outbound request: ${reason}`);
    this.name = "BlockedOutboundError";
    this.reason = reason;
  }
}

/** Did the SSRF guard refuse this request? (By type; the name survives a realm hop.) */
export function isBlockedOutboundError(
  err: unknown
): err is BlockedOutboundError {
  return (
    err instanceof BlockedOutboundError ||
    (err instanceof Error && err.name === "BlockedOutboundError")
  );
}
