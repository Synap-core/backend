/**
 * JWKS Client — verifies ES256 JWTs issued by any Control Plane.
 *
 * Flow:
 *   1. Resolve issuer URL: use the pinned `cpUrl` if provided (allowlist mode),
 *      or fall back to the `iss` claim in the JWT itself (OIDC-style discovery).
 *   2. Fetch /.well-known/jwks.json from the resolved issuer URL on first use.
 *   3. Cache the public key in memory (no rotation needed in the same process).
 *   4. Verify incoming JWT signature + issuer claim.
 *   5. Track used `jti` claims to prevent replay attacks (LRU, 15 min TTL).
 *
 * Pods do NOT need CONTROL_PLANE_URL configured: any CP that signs JWTs with
 * its own URL as `iss` can provision agents on this pod. Set CONTROL_PLANE_URL
 * to restrict to a single trusted CP (allowlist mode).
 */

import crypto, { type JsonWebKey as CryptoJsonWebKey } from "crypto";
import jwt from "jsonwebtoken";
import { createLogger } from "@synap-core/core";
import { TrustedIssuerService } from "@synap/database";

const logger = createLogger({ module: "jwks-client" });

// ---------------------------------------------------------------------------
// JWKS cache (per Control Plane URL)
// ---------------------------------------------------------------------------

interface JwksCache {
  publicKeyPem: string;
  fetchedAt: number;
  /** Last successfully fetched key — used as fallback when refresh fails */
  lastKnownGood?: { publicKeyPem: string; fetchedAt: number };
}

const cache = new Map<string, JwksCache>();

// Refresh JWKS every 24 h (key rotation is rare; 24 h is the industry standard)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Last-known-good fallback window: 48 h
const LAST_KNOWN_GOOD_TTL_MS = 48 * 60 * 60 * 1000;
// Retry delays for transient fetch failures: 1s, 5s, 30s
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

async function fetchPublicKeyPem(cpUrl: string): Promise<string> {
  const res = await fetch(`${cpUrl}/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    throw new Error(`JWKS fetch failed: ${res.status} from ${cpUrl}`);
  }

  const body = (await res.json()) as { keys?: CryptoJsonWebKey[] };
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`JWKS response contained no keys from ${cpUrl}`);
  }

  // Use the first ES256 key (or the only key if no alg filter needed)
  const jwk = keys.find((k) => k.alg === "ES256" || k.kty === "EC") ?? keys[0];
  if (!jwk) {
    throw new Error(`No suitable key found in JWKS from ${cpUrl}`);
  }

  const publicKeyObj = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return publicKeyObj.export({ type: "spki", format: "pem" }) as string;
}

async function getPublicKeyPem(cpUrl: string): Promise<string> {
  const cached = cache.get(cpUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.publicKeyPem;
  }

  // Attempt fetch with exponential backoff retries
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const publicKeyPem = await fetchPublicKeyPem(cpUrl);
      const entry: JwksCache = {
        publicKeyPem,
        fetchedAt: Date.now(),
        lastKnownGood: { publicKeyPem, fetchedAt: Date.now() },
      };
      // Preserve last-known-good from previous entry if this is a refresh
      if (cached?.lastKnownGood) {
        entry.lastKnownGood = { publicKeyPem, fetchedAt: Date.now() };
      }
      cache.set(cpUrl, entry);
      logger.info({ cpUrl, attempt }, "JWKS public key cached");
      return publicKeyPem;
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger.warn(
          { cpUrl, attempt, delay, err },
          `JWKS fetch failed — retrying in ${delay}ms`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // All retries exhausted — fall back to last-known-good if within 48 h window
  const lkg = cached?.lastKnownGood;
  if (lkg && Date.now() - lkg.fetchedAt < LAST_KNOWN_GOOD_TTL_MS) {
    const ageHours = Math.round((Date.now() - lkg.fetchedAt) / 3_600_000);
    logger.warn(
      { cpUrl, ageHours, err: lastError },
      `JWKS fetch failed after retries — using last-known-good key (${ageHours}h old). ` +
        "CP may be temporarily unreachable."
    );
    return lkg.publicKeyPem;
  }

  // No fallback available — clear cache so next request retries fresh
  cache.delete(cpUrl);
  throw lastError;
}

// ---------------------------------------------------------------------------
// JTI replay prevention — LRU cache of recently-seen JWT IDs
//
// Protects against token replay: if an intercepted provisioning JWT is
// submitted a second time, the jti check rejects it immediately.
//
// Implementation: Map<jti, expiresAt (ms)> with a max size cap and a
// periodic sweep so memory stays bounded even under abuse.
// ---------------------------------------------------------------------------

const JTI_TTL_MS = 15 * 60 * 1000; // 15 minutes — covers typical 10-min token lifetime
const JTI_MAX_SIZE = 500; // hard cap; oldest entries dropped when limit hit

const usedJtis = new Map<string, number>(); // jti → expiresAt timestamp

// Sweep expired JTIs every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [jti, expiresAt] of usedJtis) {
      if (expiresAt < now) usedJtis.delete(jti);
    }
  },
  5 * 60 * 1000
).unref(); // .unref() so this timer doesn't prevent process exit

/**
 * Returns true if the jti has already been used (replay detected).
 * Registers the jti as used if it hasn't been seen before.
 */
function checkAndConsumeJti(jti: string): boolean {
  if (usedJtis.has(jti)) {
    return true; // replay
  }

  // Enforce hard cap — drop the oldest entry when full
  if (usedJtis.size >= JTI_MAX_SIZE) {
    const oldest = usedJtis.keys().next().value;
    if (oldest !== undefined) usedJtis.delete(oldest);
  }

  usedJtis.set(jti, Date.now() + JTI_TTL_MS);
  return false; // first use — ok
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Verify a JWT issued by a Control Plane using ES256 (ECDSA P-256).
 *
 * Returns the decoded payload if valid, or null if:
 *   - Issuer URL cannot be resolved (no cpUrl and no HTTPS iss claim)
 *   - JWKS fetch fails
 *   - Signature / issuer / expiry / audience check fails
 *   - jti has already been used (replay attack)
 *
 * Issuer resolution (OIDC-style):
 *   - If `cpUrl` is provided: use it as the JWKS source AND enforce that the
 *     token's `iss` matches it (allowlist / trust-pinning mode).
 *   - If `cpUrl` is omitted/undefined: decode the JWT without verification,
 *     extract the `iss` claim, and use it as the JWKS source. The `iss` must
 *     be an HTTPS URL. Pods that set CONTROL_PLANE_URL get allowlist mode;
 *     pods without it accept any properly-signed HTTPS issuer.
 *
 * Pass `audience` when the token was signed with an `aud` claim (e.g. handshake
 * tokens carry `aud: podUrl`). Omit for tokens that have no audience claim.
 *
 * Callers should treat null as "unverified — apply safe defaults (solo tier, etc.)".
 */
export async function verifyCpJwt<T extends object>(
  token: string,
  cpUrl?: string | undefined,
  audience?: string
): Promise<T | null> {
  // ── Resolve issuer URL ────────────────────────────────────────────────────
  let issuerUrl = cpUrl;

  if (!issuerUrl) {
    // Decode without verification to read the iss claim (standard OIDC pattern)
    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded !== "object") {
      logger.debug("verifyCpJwt: cannot decode token — skipping");
      return null;
    }
    const iss = (decoded as Record<string, unknown>).iss;
    if (typeof iss !== "string" || !iss.startsWith("https://")) {
      logger.debug(
        { iss },
        "verifyCpJwt: iss is not an HTTPS URL and no cpUrl provided — cannot verify"
      );
      return null;
    }
    issuerUrl = iss;
    logger.debug(
      { issuerUrl },
      "verifyCpJwt: resolved issuer URL from iss claim"
    );
  }

  // ── Verify signature ──────────────────────────────────────────────────────
  try {
    const publicKeyPem = await getPublicKeyPem(issuerUrl);
    const payload = jwt.verify(token, publicKeyPem, {
      algorithms: ["ES256"],
      issuer: issuerUrl,
      ...(audience ? { audience } : {}),
    }) as T & { jti?: string };

    // JTI replay check — reject tokens whose ID has been seen before.
    // jti is MANDATORY: a token without one cannot be tracked for replay,
    // so we refuse it outright. The canonical CP mint (`signCpJwt` in
    // synap-control-plane-api) always emits `jti: crypto.randomUUID()`,
    // so any assertion missing the claim is malformed or hand-crafted.
    if (typeof payload.jti !== "string" || payload.jti.length === 0) {
      logger.error(
        { issuerUrl },
        "verifyCpJwt: missing jti — token rejected (replay protection requires jti)"
      );
      return null;
    }
    if (checkAndConsumeJti(payload.jti)) {
      logger.warn(
        { jti: payload.jti },
        "verifyCpJwt: JTI replay detected — token rejected"
      );
      return null;
    }

    return payload as T;
  } catch (err) {
    logger.warn({ err, issuerUrl }, "verifyCpJwt: token verification failed");

    // If JWKS fetch failed, clear cache so next attempt retries
    if (err instanceof Error && err.message.includes("JWKS fetch failed")) {
      cache.delete(issuerUrl);
    }

    return null;
  }
}

/**
 * Verify a CP-signed JWT AND enforce that its issuer is an approved entry in
 * the pod's `trusted_issuers` registry.
 *
 * This is the hardened variant of {@link verifyCpJwt} that ALL CP→pod entry
 * points should use. Plain `verifyCpJwt` only checks the JWT's cryptographic
 * validity, which means any HTTPS domain serving a valid JWKS could sign a
 * token that passes verification. `verifyCpJwtWithTrust` layers the pod-local
 * trust allowlist on top, so only issuers that the pod admin (or the built-in
 * seed) has explicitly approved can authenticate.
 *
 * Flow:
 *   1. Delegate signature / issuer / expiry / audience / jti check to `verifyCpJwt`.
 *   2. On success, look up the payload's `iss` claim in `trusted_issuers`.
 *   3. Return the payload ONLY if the entry exists AND `status === "approved"`.
 *
 * Returns null on any rejection (verify failure, unknown issuer, non-approved status).
 *
 * Issuer pinning: if `opts.pinnedIssuer` is not provided, this function
 * automatically falls back to `process.env.CONTROL_PLANE_URL` (set at install
 * time by install.sh). On managed pods this prevents OIDC-style discovery from
 * an unverified `iss` claim — only the pre-configured CP JWKS is used for
 * signature verification.
 *
 * @param token - The JWT to verify.
 * @param opts.pinnedIssuer - Optional explicit override. If omitted, falls back
 *   to `CONTROL_PLANE_URL` env var, then to OIDC-style iss discovery.
 * @param opts.audience - Required non-empty audience string (typically the pod's
 *   PUBLIC_URL). Callers MUST refuse the request before calling this function if
 *   they cannot supply an audience — there is no way to skip the check here.
 */
export async function verifyCpJwtWithTrust<T extends object>(
  token: string,
  opts: {
    pinnedIssuer?: string;
    audience: string;
    /** Optional registry scope required by this specific endpoint. */
    requiredScope?: string;
  }
): Promise<T | null> {
  // Pin to the configured CP URL (set at install time) when not explicitly
  // overridden. This prevents OIDC-style discovery from the unverified iss
  // claim on managed pods — the signature is always verified against the
  // known-good JWKS endpoint, not one the token claims.
  const pinnedIssuer =
    opts.pinnedIssuer ?? process.env.CONTROL_PLANE_URL ?? undefined;
  const payload = await verifyCpJwt<T>(token, pinnedIssuer, opts.audience);
  if (!payload) {
    return null;
  }

  // Extract the iss claim from the verified payload — verifyCpJwt has already
  // enforced that the signature matches this issuer's JWKS.
  const iss = (payload as Record<string, unknown>).iss;
  if (typeof iss !== "string") {
    logger.warn(
      { iss },
      "verifyCpJwtWithTrust: payload missing iss claim — rejected"
    );
    return null;
  }

  try {
    const svc = new TrustedIssuerService();
    const entry = await svc.getByUrl(iss);
    if (!entry) {
      logger.warn(
        { issuerUrl: iss },
        "verifyCpJwtWithTrust: issuer not in trusted_issuers registry — rejected"
      );
      return null;
    }
    if (entry.status !== "approved") {
      logger.warn(
        { issuerUrl: iss, status: entry.status },
        "verifyCpJwtWithTrust: issuer registry entry is not approved — rejected"
      );
      return null;
    }
    if (
      opts.requiredScope &&
      !entry.allowedScopes.includes(opts.requiredScope)
    ) {
      logger.warn(
        { issuerUrl: iss, requiredScope: opts.requiredScope },
        "verifyCpJwtWithTrust: issuer is not approved for the required scope — rejected"
      );
      return null;
    }
    return payload;
  } catch (err) {
    logger.warn(
      { err, issuerUrl: iss },
      "verifyCpJwtWithTrust: trusted-issuer lookup failed — rejected"
    );
    return null;
  }
}

/**
 * Clears the JWKS cache for a given CP URL (useful for testing or key rotation).
 */
export function clearJwksCache(cpUrl?: string): void {
  if (cpUrl) {
    cache.delete(cpUrl);
  } else {
    cache.clear();
  }
}

/**
 * Clears the JTI replay cache (useful for testing only).
 */
export function clearJtiCache(): void {
  usedJtis.clear();
}
