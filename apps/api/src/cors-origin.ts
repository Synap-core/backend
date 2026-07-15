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
import {
  and,
  arrayContains,
  eq,
  federatedApplicationConnections,
  getDb,
  trustedIssuers,
} from "@synap/database";
import { normalizeIssuerUrl } from "@synap/api";

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
 * Check whether a Pod owner has approved this exact browser origin for an
 * application connection. This is intentionally an exact database lookup,
 * not a wildcard or an environment allowlist: the connection is revocable in
 * Pod Admin and remains independent of any particular issuer implementation.
 *
 * An approved origin receives only browser transport permission. Every API
 * route still authenticates the user and enforces their local Pod membership;
 * CORS itself is never a data-plane authorization grant.
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
        columns: { issuerId: true },
      }
    );
    if (!connection) return false;
    // A connection never outlives its issuer approval. This second lookup is
    // intentional: a Pod owner can revoke an issuer without having to find
    // and revoke every application connection created beneath it.
    const issuer = await db.query.trustedIssuers.findFirst({
      where: and(
        eq(trustedIssuers.id, connection.issuerId),
        eq(trustedIssuers.status, "approved")
      ),
      columns: { id: true },
    });
    return Boolean(issuer);
  } catch {
    // A database outage must never degrade into reflecting an unknown Origin.
    return false;
  }
}

/**
 * Strict browser transport check for the federation bootstrap endpoints.
 * The `application_id` appears in the endpoint URL so browsers include it in
 * preflight. The federation route then compares it with the signed `azp`
 * assertion claim. This prevents one approved application origin from reading
 * another application's signed exchange response.
 */
export async function isApprovedApplicationOriginForClient(
  origin: string | undefined,
  clientId: string | undefined,
  issuerUrl: string | undefined
): Promise<boolean> {
  const normalized = origin ? normalizeOrigin(origin) : null;
  const normalizedIssuer = issuerUrl ? normalizeIssuerUrl(issuerUrl) : null;
  if (
    !normalized ||
    !clientId ||
    !normalizedIssuer ||
    !/^[a-zA-Z0-9._-]{3,128}$/.test(clientId)
  ) {
    return false;
  }

  try {
    const db = await getDb();
    const issuer = await db.query.trustedIssuers.findFirst({
      where: and(
        eq(trustedIssuers.issuerUrl, normalizedIssuer),
        eq(trustedIssuers.status, "approved")
      ),
      columns: { id: true },
    });
    if (!issuer) return false;
    const connection = await db.query.federatedApplicationConnections.findFirst(
      {
        where: and(
          eq(federatedApplicationConnections.status, "approved"),
          eq(federatedApplicationConnections.issuerId, issuer.id),
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
