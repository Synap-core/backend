/**
 * Safe issuer URL resolution for outbound JWKS requests.
 *
 * An issuer URL ultimately controls an outbound connection. This module keeps
 * that capability deliberately narrow: HTTPS only, no local hostnames, every
 * DNS answer must be publicly routable, and callers receive the resolved IP so
 * they can connect without a second DNS lookup (which would enable rebinding).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface IssuerDnsRecord {
  address: string;
  family: number;
}

export type IssuerDnsLookup = (
  hostname: string
) => Promise<readonly IssuerDnsRecord[]>;

export interface ResolvedIssuerEndpoint {
  /** Normalized issuer URL, used for diagnostics only. */
  issuerUrl: string;
  /** Original URL hostname without IPv6 brackets, used for TLS SNI. */
  hostname: string;
  /** HTTP Host header, including a non-default port when present. */
  hostHeader: string;
  /** Public IP selected during validation and pinned for the request. */
  address: string;
  family: 4 | 6;
  port: number;
  jwksPath: string;
}

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
  "metadata.google.internal",
  "metadata.aws.internal",
  "host.docker.internal",
  "gateway.docker.internal",
]);

const BLOCKED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal"];

/**
 * Canonical form for a trusted issuer identifier.
 *
 * Issuers may use a path (for example, an OIDC tenant), but credentials,
 * queries, fragments, and a trailing slash make the same issuer spellable in
 * multiple ways. The registry and a JWT `iss` claim must use this exact form.
 */
export function normalizeIssuerUrl(rawIssuerUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawIssuerUrl);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname}`;
}

async function systemLookup(
  hostname: string
): Promise<readonly IssuerDnsRecord[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function withoutIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, "");
  return (
    BLOCKED_HOSTNAMES.has(normalized) ||
    BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) {
    return null;
  }

  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  return octets.length === 4 && octets.every(Number.isInteger) ? octets : null;
}

function isNonPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) {
    return true;
  }

  const [a, b, c] = octets;

  return (
    // Unspecified, private, carrier-grade NAT, loopback, and link-local.
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // IETF special-purpose and documentation ranges are never valid issuers.
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 192 && b === 31 && c === 196) ||
    (a === 192 && b === 52 && c === 193) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 175 && c === 48) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    // Multicast, reserved, and limited broadcast.
    a >= 224
  );
}

/**
 * Expands an IPv6 address to eight 16-bit groups. It deliberately supports
 * IPv4 tails because DNS implementations may return mapped IPv6 addresses.
 */
function expandIpv6(address: string): number[] | null {
  let normalized = withoutIpv6Brackets(address).toLowerCase();

  if (normalized.includes(".")) {
    const finalColon = normalized.lastIndexOf(":");
    const ipv4 = parseIpv4(normalized.slice(finalColon + 1));
    if (finalColon < 0 || !ipv4) {
      return null;
    }
    normalized = `${normalized.slice(0, finalColon)}:${(
      (ipv4[0] << 8) |
      ipv4[1]
    ).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const compressionIndex = normalized.indexOf("::");
  if (
    compressionIndex !== -1 &&
    compressionIndex !== normalized.lastIndexOf("::")
  ) {
    return null;
  }

  const left =
    compressionIndex === -1
      ? normalized.split(":")
      : normalized.slice(0, compressionIndex).split(":").filter(Boolean);
  const right =
    compressionIndex === -1
      ? []
      : normalized
          .slice(compressionIndex + 2)
          .split(":")
          .filter(Boolean);

  if (
    left.some((group) => !/^[0-9a-f]{1,4}$/.test(group)) ||
    right.some((group) => !/^[0-9a-f]{1,4}$/.test(group)) ||
    (compressionIndex === -1 && left.length !== 8) ||
    (compressionIndex !== -1 && left.length + right.length >= 8)
  ) {
    return null;
  }

  const missingGroups = 8 - left.length - right.length;
  const groups = [
    ...left,
    ...Array.from({ length: missingGroups }, () => "0"),
    ...right,
  ];

  return groups.map((group) => Number.parseInt(group, 16));
}

function isNonPublicIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  if (!groups) {
    return true;
  }

  const [first, second, third] = groups;
  const firstSixAreZero = groups.slice(0, 6).every((group) => group === 0);
  const firstFiveAreZero = groups.slice(0, 5).every((group) => group === 0);

  return (
    // IPv4-compatible/mapped and IPv4-translated forms are not valid issuer
    // endpoints. Rejecting the entire form closes IPv4-in-IPv6 bypasses.
    firstSixAreZero ||
    (firstFiveAreZero && groups[5] === 0xffff) ||
    // Unique-local, link-local, deprecated site-local, and multicast.
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xffc0) === 0xfec0 ||
    (first & 0xff00) === 0xff00 ||
    // Non-public IPv6 special-use ranges, including documentation and tunnels.
    (first === 0x64 && second === 0xff9b && (third === 0 || third === 1)) ||
    (first === 0x100 && second === 0) ||
    (first === 0x2001 &&
      (second === 0 || second === 0x2 || second === 0xdb8)) ||
    first === 0x2002
  );
}

export function isPublicInternetAddress(address: string): boolean {
  const normalized = withoutIpv6Brackets(address);
  const family = isIP(normalized);

  if (family === 4) {
    return !isNonPublicIpv4(normalized);
  }
  if (family === 6) {
    return !isNonPublicIpv6(normalized);
  }
  return false;
}

/**
 * Validates an issuer URL and resolves it to a public IP address.
 *
 * Every address returned for a hostname must be public. This intentionally
 * rejects mixed public/private DNS answers, because accepting one would leave
 * a DNS-rebinding path to a private Pod service.
 */
export async function resolvePublicIssuerEndpoint(
  rawIssuerUrl: string,
  resolveDns: IssuerDnsLookup = systemLookup
): Promise<ResolvedIssuerEndpoint> {
  const issuerUrl = normalizeIssuerUrl(rawIssuerUrl);
  if (!issuerUrl) {
    throw new Error(
      "Issuer URL must be HTTPS and cannot include credentials, a query, or a fragment"
    );
  }
  const parsed = new URL(issuerUrl);

  const hostname = withoutIpv6Brackets(parsed.hostname);
  if (!hostname || isBlockedHostname(hostname)) {
    throw new Error("Issuer URL must not target a local hostname");
  }

  const literalFamily = isIP(hostname);
  const records: readonly IssuerDnsRecord[] = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await resolveDns(hostname);

  if (records.length === 0) {
    throw new Error("Issuer hostname did not resolve to an IP address");
  }

  const normalizedRecords = records.map((record) => ({
    ...record,
    address: withoutIpv6Brackets(record.address),
  }));
  const unsafeRecord = normalizedRecords.find(
    (record) =>
      (record.family !== 4 && record.family !== 6) ||
      isIP(record.address) !== record.family ||
      !isPublicInternetAddress(record.address)
  );

  if (unsafeRecord) {
    throw new Error("Issuer URL resolves to a non-public IP address");
  }

  const selected = normalizedRecords[0];
  if (!selected) {
    throw new Error("Issuer hostname did not resolve to an IP address");
  }

  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Issuer URL has an invalid port");
  }

  const issuerPath = parsed.pathname.replace(/\/+$/, "");
  return {
    issuerUrl,
    hostname,
    hostHeader: parsed.host,
    address: selected.address,
    family: selected.family as 4 | 6,
    port,
    jwksPath: `${issuerPath}/.well-known/jwks.json`,
  };
}
