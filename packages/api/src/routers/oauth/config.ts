/**
 * Deployment-level configuration for the pod's OAuth 2.1 authorization server.
 *
 * The two things every endpoint needs and neither `protocol.ts` (pure) nor
 * `store.ts` (storage) should own: WHICH issuer this pod is, and WHICH scopes it
 * is willing to grant.
 */

import { canonicalizeIssuerUrl } from "./protocol.js";

/**
 * Agent type for a Path-B (pod-as-AS) grant.
 *
 * Deliberately distinct from Path A's `claude-web` (CP-as-AS + consent code, see
 * hub-protocol/rest/mcp-redeem.ts). Both paths mint the same KIND of thing — an
 * `api_keys` row owned by a pod-wide agent user — but keeping the agentType
 * separate means the two trust paths are separable in the data: a pod owner can
 * see, audit and revoke "Claude talked to me directly" independently of "Claude
 * talked to me through the control plane", and /mcp/revoke's `agentType ===
 * "claude-web"` security floor can never reach a Path-B key.
 */
export const OAUTH_AGENT_TYPE = "claude-web-direct";

/**
 * Scopes this AS advertises and is willing to grant, in POD grammar.
 *
 * Pod grammar (dot) rather than the CP's wire grammar (colon) because these
 * strings are what ends up on the minted `api_keys` row, and
 * `mapCpScopesToPodScopes` — which owns the mcp→hub-protocol peering rule — is
 * tolerant of both spellings. Inbound requests are normalized to this grammar by
 * `normalizeRequestedScopes` before any intersection, so a client that asks in
 * either grammar gets exactly what it asked for rather than falling through to
 * the registered default.
 *
 * `offline_access` is deliberately absent: this AS issues no refresh token (see
 * `buildAuthorizationServerMetadata`), and advertising a scope we never honor is
 * a lie a client acts on.
 */
export const OAUTH_SUPPORTED_SCOPES = ["mcp.read", "mcp.write"] as const;

/** Granted when a client registers or authorizes without naming any scope. */
export const OAUTH_DEFAULT_SCOPES = ["mcp.read", "mcp.write"] as const;

/**
 * The pod's canonical issuer, or null when `PUBLIC_URL` is unset/unusable.
 *
 * RFC 8414 §2 requires the metadata `issuer` to be the exact string a client can
 * both concatenate endpoint paths onto AND compare byte-for-byte against the
 * origin it fetched the document from — so an AS that cannot name itself
 * canonically must not serve metadata at all. Every endpoint returns 503 rather
 * than guessing from the request Host header, which is attacker-controlled and
 * would let a Host-spoofed request mint a document pointing at another origin.
 *
 * Read at call time (not module load) so tests and a re-exec'd process see the
 * current environment.
 */
export function resolveIssuer(): string | null {
  return canonicalizeIssuerUrl(process.env.PUBLIC_URL, {
    // Loopback http is a development affordance only. In production the issuer
    // must be https, matching `normalizeIssuerUrl`'s rule for trusted issuers.
    allowInsecureLoopback: process.env.NODE_ENV !== "production",
  });
}

/**
 * Normalize inbound scope strings to pod grammar.
 *
 * claude.ai and the CP speak `mcp:read`; the pod's `api_keys.scope` column holds
 * `mcp.read`. Normalizing BEFORE `narrowScopes` intersects matters: without it,
 * a request for `mcp:read` alone would intersect to nothing against a client
 * registered for `["mcp.read","mcp.write"]`, and the empty-intersection fallback
 * would silently grant WRITE to a caller that only asked to read.
 */
export function normalizeRequestedScopes(
  requested: readonly string[]
): string[] {
  return requested.map((s) => s.replace(/:/g, "."));
}
