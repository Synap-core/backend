/**
 * First-party CORS origin policy (Pattern B — derive, don't reflect-all)
 *
 * The pod serves many first-party browser surfaces on operator-chosen origins
 * (studio., app., devplane., relay., …) that all live under one base domain.
 * Rather than enumerate them (drift) or reflect every origin (the textbook
 * CSWSH/credentialed-CORS vulnerability), we DERIVE the allowlist:
 *
 *   - SYNAP_BASE_DOMAIN (e.g. "example.com") → allow it + any "*.example.com"
 *   - the explicit ALLOWED_ORIGINS list (+ DB-dynamic + dev localhost) via getCorsOrigins()
 *   - the pod's own PUBLIC_URL origin
 *
 * Absent Origin (Electron/desktop, curl, same-origin) → allowed (CORS N/A).
 * A literal "null" Origin (sandboxed iframe/data:) → never trusted.
 * Nothing configured → cross-origin denied (fail closed). This mirrors how Ory
 * Kratos (which we use) is configured: allowed_origins: [https://*.BASE].
 */

import { getCorsOrigins } from "./middleware/security.js";

/** Canonicalize to scheme://host[:port]; null if invalid or the literal "null". */
function normalizeOrigin(value: string): string | null {
  if (!value || value === "null") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function getBaseDomain(): string | null {
  const raw = process.env.SYNAP_BASE_DOMAIN?.trim().replace(/^\.+/, "");
  return raw ? raw.toLowerCase() : null;
}

/** Explicit allowlist: ALLOWED_ORIGINS + DB-dynamic + dev localhost + PUBLIC_URL. */
function explicitOrigins(): Set<string> {
  const set = new Set<string>();
  for (const o of getCorsOrigins()) {
    const n = normalizeOrigin(o);
    if (n) set.add(n);
  }
  const publicUrl = process.env.PUBLIC_URL
    ? normalizeOrigin(process.env.PUBLIC_URL)
    : null;
  if (publicUrl) set.add(publicUrl);
  return set;
}

/**
 * Is this request Origin a trusted first party?
 * - undefined Origin (native/desktop/same-origin) → true (CORS does not apply)
 * - exact base domain or any subdomain of SYNAP_BASE_DOMAIN → true
 * - origin in the explicit allowlist → true
 * - otherwise (incl. "null") → false
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true; // not a browser cross-origin request
  const norm = normalizeOrigin(origin);
  if (!norm) return false; // malformed or "null"

  const base = getBaseDomain();
  if (base) {
    try {
      const u = new URL(norm);
      const host = u.hostname.toLowerCase();
      // Derived subdomain trust requires https + the default port, so a plain-http
      // or odd-port first-party subdomain (e.g. a MinIO console on :9001) is NOT
      // auto-trusted. Dev allows http for localhost convenience.
      const schemeOk =
        u.protocol === "https:" || process.env.NODE_ENV !== "production";
      if (
        schemeOk &&
        u.port === "" &&
        (host === base || host.endsWith(`.${base}`))
      ) {
        return true;
      }
    } catch {
      /* fall through to explicit list */
    }
  }
  return explicitOrigins().has(norm);
}

/**
 * Whether any first-party origin can be matched at all. Used at startup to warn
 * when neither SYNAP_BASE_DOMAIN nor an explicit allowlist is set — in that case
 * every cross-origin browser request is denied (fail closed) and the operator's
 * cross-subdomain frontends will not be able to reach the pod until configured.
 */
export function hasConfiguredOrigins(): boolean {
  return getBaseDomain() !== null || explicitOrigins().size > 0;
}
