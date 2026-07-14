/**
 * JWKS Client — verifies ES256 JWTs issued by an external issuer.
 *
 * Flow:
 *   1. Resolve issuer URL: use a pinned issuer if provided (allowlist mode),
 *      or fall back to the `iss` claim in the JWT itself (OIDC-style discovery).
 *   2. Fetch /.well-known/jwks.json from the resolved issuer URL on first use.
 *   3. Cache the public key in memory (no rotation needed in the same process).
 *   4. Verify incoming JWT signature + issuer claim.
 *   5. Track used `jti` claims to prevent replay attacks (LRU, 15 min TTL).
 *
 * `verifyTrustedIssuerJwt` establishes authorization through the Pod-local
 * `trusted_issuers` registry. `verifyIssuerJwt` is a lower-level cryptographic
 * verifier; privileged entry points should use the trusted variant unless they
 * already enforce an equivalent issuer policy. Neither uses environment-based
 * implicit trust.
 */

import crypto, { type JsonWebKey as CryptoJsonWebKey } from "crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import jwt from "jsonwebtoken";
import { createLogger } from "@synap-core/core";
import { TrustedIssuerService } from "@synap/database";
import {
  normalizeIssuerUrl,
  resolvePublicIssuerEndpoint,
  type ResolvedIssuerEndpoint,
} from "./issuer-url-safety.js";

const logger = createLogger({ module: "jwks-client" });

// ---------------------------------------------------------------------------
// JWKS cache (per issuer URL)
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

const JWKS_REQUEST_TIMEOUT_MS = 10_000;
const MAX_JWKS_RESPONSE_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function fetchJwksBody(target: ResolvedIssuerEndpoint): Promise<string> {
  return new Promise((resolve, reject) => {
    // The connection uses the already-validated IP, not target.hostname. This
    // pins the DNS result through the TLS connection and closes a rebinding
    // window between validation and the request. SNI and Host still use the
    // issuer hostname, so normal TLS certificate validation remains intact.
    const request = httpsRequest(
      {
        protocol: "https:",
        hostname: target.address,
        port: target.port,
        path: target.jwksPath,
        method: "GET",
        headers: {
          accept: "application/json",
          host: target.hostHeader,
        },
        servername: isIP(target.hostname) === 0 ? target.hostname : undefined,
        timeout: JWKS_REQUEST_TIMEOUT_MS,
        // JWKS is cached for 24h. A dedicated connection avoids a TLS socket
        // authenticated for one issuer being reused for another hostname.
        agent: false,
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(
            new Error(
              `JWKS fetch failed: ${statusCode} from ${target.issuerUrl}`
            )
          );
          return;
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        response.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_JWKS_RESPONSE_BYTES) {
            const error = new Error(
              `JWKS response exceeded ${MAX_JWKS_RESPONSE_BYTES} bytes from ${target.issuerUrl}`
            );
            response.destroy(error);
            reject(error);
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      }
    );

    request.once("timeout", () => {
      request.destroy(
        new Error(`JWKS fetch timed out after ${JWKS_REQUEST_TIMEOUT_MS}ms`)
      );
    });
    request.once("error", reject);
    request.end();
  });
}

async function fetchPublicKeyPem(
  target: ResolvedIssuerEndpoint
): Promise<string> {
  let body: unknown;
  try {
    body = JSON.parse(await fetchJwksBody(target)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `JWKS response was not valid JSON from ${target.issuerUrl}`
      );
    }
    throw error;
  }

  if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error(`JWKS response contained no keys from ${target.issuerUrl}`);
  }

  const keys = body.keys.filter((key): key is CryptoJsonWebKey =>
    isRecord(key)
  );
  if (keys.length === 0) {
    throw new Error(
      `JWKS response contained no usable keys from ${target.issuerUrl}`
    );
  }

  // Use the first ES256 key (or the only key if no alg filter needed).
  const jwk =
    keys.find((key) => key.alg === "ES256" || key.kty === "EC") ?? keys[0];
  if (!jwk) {
    throw new Error(`No suitable key found in JWKS from ${target.issuerUrl}`);
  }

  const publicKeyObj = crypto.createPublicKey({ key: jwk, format: "jwk" });
  return publicKeyObj.export({ type: "spki", format: "pem" }) as string;
}

async function getPublicKeyPem(issuerUrl: string): Promise<string> {
  const cached = cache.get(issuerUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.publicKeyPem;
  }

  // Resolve exactly once before issuing any request. fetchPublicKeyPem connects
  // to target.address directly, so retries cannot be redirected through a new
  // DNS response after this safety check.
  const target = await resolvePublicIssuerEndpoint(issuerUrl);

  // Attempt fetch with exponential backoff retries
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const publicKeyPem = await fetchPublicKeyPem(target);
      const fetchedAt = Date.now();
      const entry: JwksCache = {
        publicKeyPem,
        fetchedAt,
        lastKnownGood: { publicKeyPem, fetchedAt },
      };
      cache.set(issuerUrl, entry);
      logger.info({ issuerUrl, attempt }, "JWKS public key cached");
      return publicKeyPem;
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        logger.warn(
          { issuerUrl, attempt, delay, err },
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
      { issuerUrl, ageHours, err: lastError },
      `JWKS fetch failed after retries — using last-known-good key (${ageHours}h old). ` +
        "Issuer may be temporarily unreachable."
    );
    return lkg.publicKeyPem;
  }

  // No fallback available — clear cache so next request retries fresh
  cache.delete(issuerUrl);
  throw lastError;
}

// ---------------------------------------------------------------------------
// JTI replay prevention — LRU cache of recently-seen JWT IDs
//
// Protects against token replay: if an intercepted issuer assertion is
// submitted a second time, the jti check rejects it immediately.
//
// Implementation: Map<issuerUrl + jti, expiresAt (ms)> with a max size cap
// and a periodic sweep so memory stays bounded even under abuse. A JTI is
// meaningful only in its issuer namespace, matching the durable Pod receipt.
// ---------------------------------------------------------------------------

const JTI_TTL_MS = 15 * 60 * 1000; // 15 minutes — covers typical 10-min token lifetime
const JTI_MAX_SIZE = 500; // hard cap; oldest entries dropped when limit hit

const usedJtis = new Map<string, number>(); // issuer-qualified jti → expiry

// Sweep expired JTIs every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [assertionKey, expiresAt] of usedJtis) {
      if (expiresAt < now) usedJtis.delete(assertionKey);
    }
  },
  5 * 60 * 1000
).unref(); // .unref() so this timer doesn't prevent process exit

/**
 * Returns true if the issuer-scoped JTI has already been used (replay
 * detected). Registers it if it has not been seen before.
 */
function checkAndConsumeJti(issuerUrl: string, jti: string): boolean {
  const assertionKey = `${issuerUrl}\u0000${jti}`;
  if (usedJtis.has(assertionKey)) {
    return true; // replay
  }

  // Enforce hard cap — drop the oldest entry when full
  if (usedJtis.size >= JTI_MAX_SIZE) {
    const oldest = usedJtis.keys().next().value;
    if (oldest !== undefined) usedJtis.delete(oldest);
  }

  usedJtis.set(assertionKey, Date.now() + JTI_TTL_MS);
  return false; // first use — ok
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the token's issuer solely to select a registry entry or verification
 * key. It is never treated as authenticated until jwt.verify succeeds.
 */
function readUnverifiedIssuerClaim(token: string): string | null {
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded !== "object") {
    return null;
  }

  const iss = (decoded as Record<string, unknown>).iss;
  return typeof iss === "string" && iss.length > 0 ? iss : null;
}

/**
 * Verify a JWT issued by an external issuer using ES256 (ECDSA P-256).
 *
 * Returns the decoded payload if valid, or null if:
 *   - Issuer URL cannot be resolved (no pinned issuer and no HTTPS iss claim)
 *   - JWKS fetch fails
 *   - Signature / issuer / expiry / audience check fails
 *   - jti has already been used (replay attack)
 *
 * Issuer resolution (OIDC-style):
 *   - If `pinnedIssuer` is provided: use it as the JWKS source AND enforce that the
 *     token's `iss` matches it (allowlist / trust-pinning mode).
 *   - If no issuer is pinned: decode the JWT without verification,
 *     extract the `iss` claim, and use it as the JWKS source. The `iss` must
 *     be an HTTPS URL. Callers that need a specific issuer can pin it.
 *
 * Pass `audience` when the token was signed with an `aud` claim (for example,
 * a Pod-specific issuer assertion). Omit for tokens that have no audience claim.
 *
 * Callers should treat null as an unverified assertion and deny the privileged
 * operation that required it.
 */
export async function verifyIssuerJwt<T extends object>(
  token: string,
  pinnedIssuer?: string | undefined,
  audience?: string,
  options?: { consumeJti?: boolean }
): Promise<T | null> {
  // ── Resolve issuer URL ────────────────────────────────────────────────────
  let rawIssuerUrl = pinnedIssuer;

  if (!rawIssuerUrl) {
    // Decode without verification to read the iss claim (standard OIDC pattern)
    const iss = readUnverifiedIssuerClaim(token);
    if (!iss) {
      logger.debug("verifyIssuerJwt: cannot decode token — skipping");
      return null;
    }
    if (!iss.startsWith("https://")) {
      logger.debug(
        { iss },
        "verifyIssuerJwt: iss is not an HTTPS URL and no issuer was pinned — cannot verify"
      );
      return null;
    }
    rawIssuerUrl = iss;
    logger.debug(
      { issuerUrl: rawIssuerUrl },
      "verifyIssuerJwt: resolved issuer URL from iss claim"
    );
  }

  // An issuer identifier is a database key as well as a JWT claim. Requiring
  // the exact canonical spelling prevents the same issuer from acquiring
  // multiple trust entries (for example, with and without a trailing slash).
  const issuerUrl = normalizeIssuerUrl(rawIssuerUrl);
  if (!issuerUrl || rawIssuerUrl !== issuerUrl) {
    logger.debug(
      { issuerUrl: rawIssuerUrl },
      "verifyIssuerJwt: issuer URL is not canonical — rejected"
    );
    return null;
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
    // so we refuse it outright. Any issuer assertion missing the claim is
    // malformed because replay protection cannot be applied.
    if (typeof payload.jti !== "string" || payload.jti.length === 0) {
      logger.error(
        { issuerUrl },
        "verifyIssuerJwt: missing jti — token rejected (replay protection requires jti)"
      );
      return null;
    }
    if (
      options?.consumeJti !== false &&
      checkAndConsumeJti(issuerUrl, payload.jti)
    ) {
      logger.warn(
        { issuerUrl, jti: payload.jti },
        "verifyIssuerJwt: JTI replay detected — token rejected"
      );
      return null;
    }

    return payload as T;
  } catch (err) {
    logger.warn(
      { err, issuerUrl },
      "verifyIssuerJwt: token verification failed"
    );

    // If JWKS fetch failed, clear cache so next attempt retries
    if (err instanceof Error && err.message.includes("JWKS fetch failed")) {
      cache.delete(issuerUrl);
    }

    return null;
  }
}

/**
 * Verify an issuer-signed JWT AND enforce that its issuer is an approved entry in
 * the pod's `trusted_issuers` registry.
 *
 * This is the hardened variant of {@link verifyIssuerJwt} that issuer→Pod entry
 * points should use. Plain `verifyIssuerJwt` only checks the JWT's cryptographic
 * validity, which means any HTTPS domain serving a valid JWKS could sign a
 * token that passes verification. `verifyTrustedIssuerJwt` layers the pod-local
 * trust allowlist on top, so only issuers explicitly approved by the Pod owner
 * can authenticate.
 *
 * Flow:
 *   1. Read the unverified `iss` only to find the Pod-local registry entry.
 *   2. Require an approved entry with the endpoint's optional capability.
 *   3. Fetch that approved issuer's JWKS, then verify signature, issuer,
 *      expiry, audience, and jti.
 *
 * Returns null on any rejection (verify failure, unknown issuer, non-approved status).
 *
 * Issuer pinning: when `opts.pinnedIssuer` is omitted, the token's unverified
 * `iss` selects a registry entry first. Its JWKS endpoint is fetched only
 * after that registry entry is approved. Environment configuration is never an
 * implicit trust fallback.
 *
 * @param token - The JWT to verify.
 * @param opts.pinnedIssuer - Optional explicit issuer pin. If omitted, uses
 *   OIDC-style `iss` discovery before consulting the trusted issuer registry.
 * @param opts.audience - Required non-empty audience string (typically the pod's
 *   PUBLIC_URL). Callers MUST refuse the request before calling this function if
 *   they cannot supply an audience — there is no way to skip the check here.
 * @param opts.consumeJti - Set false only when the caller persists a durable
 *   single-use receipt immediately before its mutation. Other callers retain
 *   the in-memory guard by default.
 */
export async function verifyTrustedIssuerJwt<T extends object>(
  token: string,
  opts: {
    pinnedIssuer?: string;
    audience: string;
    /** Optional registry scope required by this specific endpoint. */
    requiredScope?: string;
    /** Use only when this endpoint persists a durable JTI receipt itself. */
    consumeJti?: boolean;
  }
): Promise<T | null> {
  if (!opts.audience) {
    logger.warn(
      "verifyTrustedIssuerJwt: missing required audience — token rejected"
    );
    return null;
  }

  // Consult the Pod-local registry before fetching the issuer's JWKS. The iss
  // claim is unverified at this point, so it is only used as a lookup key; this
  // ordering prevents arbitrary token input from triggering an outbound fetch.
  const tokenIssuer = readUnverifiedIssuerClaim(token);
  if (!tokenIssuer) {
    logger.warn(
      "verifyTrustedIssuerJwt: token missing issuer claim — rejected"
    );
    return null;
  }

  const normalizedTokenIssuer = normalizeIssuerUrl(tokenIssuer);
  if (!normalizedTokenIssuer || tokenIssuer !== normalizedTokenIssuer) {
    logger.warn(
      { issuerUrl: tokenIssuer },
      "verifyTrustedIssuerJwt: issuer URL is not canonical — rejected"
    );
    return null;
  }

  const normalizedPinnedIssuer = opts.pinnedIssuer
    ? normalizeIssuerUrl(opts.pinnedIssuer)
    : undefined;
  if (
    opts.pinnedIssuer &&
    (!normalizedPinnedIssuer || opts.pinnedIssuer !== normalizedPinnedIssuer)
  ) {
    logger.warn(
      { issuerUrl: opts.pinnedIssuer },
      "verifyTrustedIssuerJwt: pinned issuer URL is not canonical — rejected"
    );
    return null;
  }

  if (normalizedPinnedIssuer && tokenIssuer !== normalizedPinnedIssuer) {
    logger.warn(
      { tokenIssuer, pinnedIssuer: normalizedPinnedIssuer },
      "verifyTrustedIssuerJwt: token issuer does not match the pinned issuer — rejected"
    );
    return null;
  }

  const issuerUrl = normalizedPinnedIssuer ?? normalizedTokenIssuer;

  try {
    const svc = new TrustedIssuerService();
    const entry = await svc.getByUrl(issuerUrl);
    if (!entry) {
      logger.warn(
        { issuerUrl },
        "verifyTrustedIssuerJwt: issuer not in trusted_issuers registry — rejected"
      );
      return null;
    }
    if (entry.status !== "approved") {
      logger.warn(
        { issuerUrl, status: entry.status },
        "verifyTrustedIssuerJwt: issuer registry entry is not approved — rejected"
      );
      return null;
    }
    if (
      opts.requiredScope &&
      (!Array.isArray(entry.allowedScopes) ||
        !entry.allowedScopes.includes(opts.requiredScope))
    ) {
      logger.warn(
        { issuerUrl, requiredScope: opts.requiredScope },
        "verifyTrustedIssuerJwt: issuer is not approved for the required scope — rejected"
      );
      return null;
    }

    // The registry grants this issuer permission to make us fetch its JWKS.
    // verifyIssuerJwt then verifies the signature and enforces the exact iss.
    return await verifyIssuerJwt<T>(token, issuerUrl, opts.audience, {
      consumeJti: opts.consumeJti,
    });
  } catch (err) {
    logger.warn(
      { err, issuerUrl },
      "verifyTrustedIssuerJwt: trusted-issuer lookup failed — rejected"
    );
    return null;
  }
}

/**
 * @deprecated Use {@link verifyIssuerJwt}. Kept while legacy Pod routes
 * migrate to generic trusted-issuer terminology.
 */
export const verifyCpJwt = verifyIssuerJwt;

/**
 * @deprecated Use {@link verifyTrustedIssuerJwt}. Kept while legacy Pod routes
 * migrate to generic trusted-issuer terminology.
 */
export const verifyCpJwtWithTrust = verifyTrustedIssuerJwt;

/**
 * Clears the JWKS cache for a given issuer URL (useful for testing or key rotation).
 */
export function clearJwksCache(issuerUrl?: string): void {
  if (issuerUrl) {
    cache.delete(issuerUrl);
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
