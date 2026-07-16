/**
 * Browser origin admission (CORS + hard server reject)
 *
 * Two independent planes:
 *
 *   1. First-party origins (SYNAP_BASE_DOMAIN / ALLOWED_ORIGINS) — Pod-owned
 *      surfaces (pod-admin, …). Not application registration.
 *
 *   2. Application origin allowlist — Pod-owner approved browser Origins in
 *      `federated_application_connections.allowed_origins`. This is ONLY
 *      transport admission (who may call the Pod from a browser). It is NOT
 *      trusted-issuer trust, membership, or data permission.
 *
 * Trusted issuers (JWT `iss`) live in `trusted_issuers` and are verified on
 * federation crypto paths separately. An approved Origin may call the Pod
 * even when a given issuer is pending; exchange still fails crypto if the
 * issuer is untrusted.
 */

import { getCorsOrigins } from "./middleware/security.js";
import {
  and,
  arrayContains,
  eq,
  federatedApplicationConnections,
  getDb,
} from "@synap/database";

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
 * Pod-owner approved browser Origin allowlist (application connection plane).
 *
 * Exact match only — no wildcards. Independent of trusted-issuer status:
 * revoking an issuer does not silently revoke CORS for an origin; the owner
 * revokes the application connection (or the origin row) for that.
 */
export async function isApprovedApplicationOrigin(
  origin: string | undefined
): Promise<boolean> {
  const normalized = origin ? normalizeOrigin(origin) : null;
  if (!normalized) return false;

  try {
    const db = await getDb();
    const connection = await db.query.federatedApplicationConnections.findFirst(
      {
        where: and(
          eq(federatedApplicationConnections.status, "approved"),
          arrayContains(federatedApplicationConnections.allowedOrigins, [
            normalized,
          ])
        ),
        columns: { id: true },
      }
    );
    return Boolean(connection);
  } catch {
    // A database outage must never degrade into reflecting an unknown Origin.
    return false;
  }
}

/**
 * Optional tighter check: origin is approved for a named application client.
 * Still does NOT consult trusted issuers — clientId is only which app
 * registered the origin (e.g. "crm"), not who signs JWTs.
 *
 * @deprecated Prefer {@link isApprovedApplicationOrigin} for transport. Kept
 * for call sites that want client-scoped admission without issuer coupling.
 */
export async function isApprovedApplicationOriginForClient(
  origin: string | undefined,
  clientId: string | undefined,
  _issuerUrl?: string | undefined
): Promise<boolean> {
  const normalized = origin ? normalizeOrigin(origin) : null;
  if (!normalized) return false;
  // No client id → same as origin-only allowlist.
  if (!clientId || !/^[a-zA-Z0-9._-]{3,128}$/.test(clientId)) {
    return isApprovedApplicationOrigin(origin);
  }

  try {
    const db = await getDb();
    const connection = await db.query.federatedApplicationConnections.findFirst(
      {
        where: and(
          eq(federatedApplicationConnections.status, "approved"),
          eq(federatedApplicationConnections.clientId, clientId),
          arrayContains(federatedApplicationConnections.allowedOrigins, [
            normalized,
          ])
        ),
        columns: { id: true },
      }
    );
    return Boolean(connection);
  } catch {
    return false;
  }
}

/**
 * CORS response headers alone cannot stop a browser from sending a request
 * after a cached preflight. Normal Pod APIs therefore reject every currently
 * unapproved external Origin at the server boundary. The opaque connection
 * request routes are intentionally excluded because they use their own
 * capability-based, credentialless policy before an app has been approved.
 */
export function rejectsUnapprovedExternalPodApiRequest(input: {
  origin: string | undefined;
  firstPartyOrigin: boolean;
  approvedApplicationOrigin: boolean;
  path: string;
  method: string;
}): boolean {
  const applicationConnectionPath = input.path.startsWith(
    "/api/federation/application-connections/"
  );
  const podApiPath =
    input.path === "/trpc" ||
    input.path.startsWith("/trpc/") ||
    input.path.startsWith("/api/");
  return Boolean(
    input.origin &&
    !input.firstPartyOrigin &&
    !input.approvedApplicationOrigin &&
    podApiPath &&
    !applicationConnectionPath &&
    input.method !== "OPTIONS"
  );
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
