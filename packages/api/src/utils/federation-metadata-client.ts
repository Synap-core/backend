/**
 * Federation Metadata Client — SSRF-safe discovery of a Control Plane's
 * authoritative federation issuer.
 *
 * A pod's CONTROL_PLANE_URL is its OUTBOUND transport URL. The CP, however,
 * SIGNS federation assertions with a deliberately independent issuer identity
 * (`getControlPlaneIssuerUrl()` on the CP side). When the two diverge, seeding
 * the trusted-issuer registry from CONTROL_PLANE_URL pins the wrong `iss` and
 * every federated /exchange silently 401s.
 *
 * This client fetches `GET ${CONTROL_PLANE_URL}/federation/metadata` so the pod
 * can DISCOVER the declared issuer instead of guessing it. It reuses the same
 * SSRF-safe machinery the JWKS fetch uses: `resolvePublicIssuerEndpoint`
 * validates the URL and pins a public IP, and the request connects to that
 * pinned IP (Host/SNI keep the real hostname) so no DNS-rebinding window opens
 * between validation and the request.
 */

import { createLogger } from "@synap-core/core";
import {
  normalizeIssuerUrl,
  resolvePublicIssuerEndpoint,
  type ResolvedIssuerEndpoint,
} from "./issuer-url-safety.js";
import { pinnedHttpsGet } from "./pinned-https-get.js";

const logger = createLogger({ module: "federation-metadata-client" });

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface FederationMetadata {
  /** Canonical issuer origin the CP signs assertions with. */
  issuer: string;
  /** JWKS endpoint the CP advertises (derived from `issuer`). */
  jwksUri: string;
  /** Bootstrap capability scopes the CP declares for itself as an issuer. */
  scopes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchMetadataBody(
  target: ResolvedIssuerEndpoint,
  path: string
): Promise<string> {
  const response = await pinnedHttpsGet(target, path, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(
      `Federation metadata fetch failed: ${response.statusCode} from ${target.issuerUrl}`
    );
  }
  return response.body;
}

/**
 * Fetch and validate the CP's federation metadata over an SSRF-safe channel.
 *
 * Throws on any failure — unresolvable/blocked URL, non-2xx, oversized body,
 * invalid JSON, or a malformed document (missing/non-canonical `issuer` or a
 * `scopes` field that is not a non-empty array of strings). Callers treat a
 * throw as "discovery unavailable" and fall back to their prior behavior.
 */
export async function fetchFederationMetadata(
  controlPlaneUrl: string
): Promise<FederationMetadata> {
  const target = await resolvePublicIssuerEndpoint(controlPlaneUrl);
  const basePath = new URL(target.issuerUrl).pathname.replace(/\/+$/, "");
  const path = `${basePath}/federation/metadata`;

  let body: unknown;
  try {
    body = JSON.parse(await fetchMetadataBody(target, path)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Federation metadata response was not valid JSON from ${target.issuerUrl}`
      );
    }
    throw error;
  }

  if (!isRecord(body) || typeof body.issuer !== "string") {
    throw new Error(
      `Federation metadata is missing an issuer from ${target.issuerUrl}`
    );
  }

  const issuer = normalizeIssuerUrl(body.issuer);
  if (!issuer || body.issuer !== issuer) {
    throw new Error(
      `Federation metadata declared a non-canonical issuer (${body.issuer}) from ${target.issuerUrl}`
    );
  }

  if (
    !Array.isArray(body.scopes) ||
    body.scopes.length === 0 ||
    !body.scopes.every(
      (s): s is string => typeof s === "string" && s.length > 0
    )
  ) {
    throw new Error(
      `Federation metadata declared invalid scopes from ${target.issuerUrl}`
    );
  }

  const jwksUri =
    typeof body.jwks_uri === "string" && body.jwks_uri.length > 0
      ? body.jwks_uri
      : `${issuer}/.well-known/jwks.json`;

  logger.debug({ issuer, scopes: body.scopes }, "Fetched federation metadata");
  return { issuer, jwksUri, scopes: body.scopes };
}
