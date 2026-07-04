/**
 * validateExternalUrl
 *
 * Guards against Server-Side Request Forgery (SSRF) by rejecting URLs that
 * resolve to private, loopback, link-local, or otherwise internal addresses.
 *
 * Use before every outbound fetch() call whose URL comes from user input or
 * the database (service registrations, relay endpoints, webhook targets).
 *
 * Lives in @synap/shared-utils so low-level packages (jobs) can reach it
 * without depending on @synap/api (which would be a circular dependency).
 *
 * Example:
 *   const check = validateExternalUrl(service.endpoint);
 *   if (!check.valid) { logger.warn(check.reason); return; }
 *   await fetch(check.url.toString(), ...);
 */

/** IPv4/IPv6 ranges that must never be reached from server-side code. */
const BLOCKED_RANGES: RegExp[] = [
  // IPv4 loopback
  /^127\./,
  // RFC 1918 private ranges
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  // Link-local / APIPA
  /^169\.254\./,
  // Shared address space (CGNAT / carrier-grade NAT)
  /^100\.64\./,
  // Unspecified
  /^0\.0\.0\.0/,
  // IPv6 loopback
  /^::1$/,
  // IPv6 ULA (unique local addresses fc00::/7)
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  // IPv6 link-local
  /^fe80:/i,
  // Cloud metadata endpoints (AWS, GCP, Azure)
  /^169\.254\.169\.254$/,
  /^metadata\.google\.internal$/i,
  /^169\.254\.170\.2$/,
];

/** Hostnames that should never be reachable from server-side code. */
const BLOCKED_HOSTNAMES: RegExp[] = [
  /^localhost$/i,
  // Docker internal DNS names for known services
  /^postgres$/i,
  /^redis$/i,
  /^minio$/i,
  /^typesense$/i,
  /^kratos$/i,
  /^hydra$/i,
  // Docker host gateway
  /^host\.docker\.internal$/i,
];

export type ValidateUrlResult =
  | { valid: true; url: URL }
  | { valid: false; reason: string };

/**
 * Validate that `raw` is a safe URL to fetch from server-side code.
 *
 * Returns `{ valid: true, url }` if safe, `{ valid: false, reason }` otherwise.
 * Does NOT make a DNS resolution — blocks by pattern matching on the hostname.
 * This is sufficient for known private ranges but won't catch DNS rebinding attacks
 * (where a public hostname resolves to a private IP). For full protection, combine
 * with an outgoing proxy that enforces network-level restrictions.
 */
export function validateExternalUrl(raw: string): ValidateUrlResult {
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

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.some((re) => re.test(hostname))) {
    return { valid: false, reason: `Hostname '${hostname}' is not allowed` };
  }

  if (BLOCKED_RANGES.some((re) => re.test(hostname))) {
    return {
      valid: false,
      reason: `URL '${hostname}' resolves to a private or reserved address`,
    };
  }

  return { valid: true, url };
}
