/**
 * JWKS Client — verifies ES256 JWTs issued by the Synap Control Plane.
 *
 * Flow:
 *   1. Fetch /.well-known/jwks.json from the Control Plane URL on first use.
 *   2. Cache the public key in memory (no rotation needed in the same process).
 *   3. Verify incoming JWT signature + issuer claim.
 *   4. Track used `jti` claims to prevent replay attacks (LRU, 15 min TTL).
 *
 * Self-hosted pods (no CONTROL_PLANE_URL) always skip verification and return
 * null from verifyCpJwt(), so callers must handle the absence of CP gracefully.
 */

import crypto, { type JsonWebKey as CryptoJsonWebKey } from "crypto";
import jwt from "jsonwebtoken";
import { createLogger } from "@synap-core/core";

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
 * Verify a JWT issued by the Synap Control Plane using ES256 (ECDSA P-256).
 *
 * Returns the decoded payload if valid, or null if:
 *   - cpUrl is not configured (self-hosted pod, no CP)
 *   - JWKS fetch fails
 *   - Signature / issuer / expiry / audience check fails
 *   - jti has already been used (replay attack)
 *
 * Pass `audience` when the token was signed with an `aud` claim (e.g. handshake
 * tokens carry `aud: podUrl`). Omit for tokens that have no audience claim.
 *
 * Callers should treat null as "unverified — apply safe defaults (solo tier, etc.)".
 */
export async function verifyCpJwt<T extends object>(
  token: string,
  cpUrl: string | undefined,
  audience?: string
): Promise<T | null> {
  if (!cpUrl) {
    logger.debug("verifyCpJwt: no cpUrl configured — skipping verification");
    return null;
  }

  try {
    const publicKeyPem = await getPublicKeyPem(cpUrl);
    const payload = jwt.verify(token, publicKeyPem, {
      algorithms: ["ES256"],
      issuer: "synap-control-plane",
      ...(audience ? { audience } : {}),
    }) as T & { jti?: string };

    // JTI replay check — reject tokens whose ID has been seen before.
    // If jti is absent (older CP versions), log a warning but allow through
    // for backward compatibility. CP should always include jti.
    if (payload.jti) {
      if (checkAndConsumeJti(payload.jti)) {
        logger.warn(
          { jti: payload.jti },
          "verifyCpJwt: JTI replay detected — token rejected"
        );
        return null;
      }
    } else {
      logger.warn(
        "verifyCpJwt: token has no jti claim — replay protection unavailable. " +
          "Ensure the Control Plane includes jti in all provisioning JWTs."
      );
    }

    return payload as T;
  } catch (err) {
    logger.warn({ err }, "verifyCpJwt: token verification failed");

    // If JWKS fetch failed, clear cache so next attempt retries
    if (err instanceof Error && err.message.includes("JWKS fetch failed")) {
      cache.delete(cpUrl);
    }

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
