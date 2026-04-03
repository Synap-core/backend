/**
 * JWKS Client — verifies ES256 JWTs issued by the Synap Control Plane.
 *
 * Flow:
 *   1. Fetch /.well-known/jwks.json from the Control Plane URL on first use.
 *   2. Cache the public key in memory (no rotation needed in the same process).
 *   3. Verify incoming JWT signature + issuer claim.
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
}

const cache = new Map<string, JwksCache>();

// Refresh JWKS every 24 h (key rotation is rare; 24 h is the industry standard)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getPublicKeyPem(cpUrl: string): Promise<string> {
  const cached = cache.get(cpUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.publicKeyPem;
  }

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
  const publicKeyPem = publicKeyObj.export({
    type: "spki",
    format: "pem",
  }) as string;

  cache.set(cpUrl, { publicKeyPem, fetchedAt: Date.now() });
  logger.info({ cpUrl }, "JWKS public key cached");

  return publicKeyPem;
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
    }) as T;
    return payload;
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
