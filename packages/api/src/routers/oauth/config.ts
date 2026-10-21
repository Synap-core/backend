/**
 * Deployment-level configuration for the pod's OAuth 2.1 authorization server.
 *
 * The two things every endpoint needs and neither `protocol.ts` (pure) nor
 * `store.ts` (storage) should own: WHICH issuer this pod is, and WHICH scopes it
 * is willing to grant.
 */

import {
  CONTROL_PLANE_ISSUER_SCOPES,
  TrustedIssuerService,
  type TrustedIssuer,
} from "@synap/database";
import { isValidScope, type ApiKeyScope } from "@synap/database/schema";

import { canonicalizeIssuerUrl } from "./protocol.js";

/**
 * Agent type for a grant to any client OTHER than this pod's approved Control
 * Plane — claude.ai, Cursor, anything that points straight at `<pod>/mcp`.
 *
 * Distinct from {@link CP_CONNECTOR_AGENT_TYPE} so the two trust paths stay
 * separable in the data: a pod owner can see, audit and revoke "Claude talked to
 * me directly" independently of "Claude talked to me through the control plane",
 * and /mcp/revoke's `agentType === "claude-web"` security floor can never reach
 * a direct key.
 */
export const OAUTH_AGENT_TYPE = "claude-web-direct";

/**
 * Agent type for the Control Plane's MCP connector (`api.synap.live/mcp`), which
 * proxies `pod__*` tools on a pod key it holds. Founder decision 6 (2026-10-15):
 * this pod's own AS mints that key too — the CP is just an OAuth client whose
 * redirect origin is the approved Control Plane's (see
 * {@link resolveOAuthAgentType}). The SAME agentType the legacy consent-code
 * path (hub-protocol/rest/mcp-redeem.ts) mints, because readers key on it:
 * `services/capability-briefs/door-tool-render.ts` renders `pod__`-prefixed tool
 * names for exactly this agentType.
 */
export const CP_CONNECTOR_AGENT_TYPE = "claude-web";

export type OAuthAgentType =
  typeof OAUTH_AGENT_TYPE | typeof CP_CONNECTOR_AGENT_TYPE;

/** The only agent types whose keys `/revoke` (RFC 7009) may revoke. */
export const OAUTH_REVOCABLE_AGENT_TYPES: readonly OAuthAgentType[] = [
  OAUTH_AGENT_TYPE,
  CP_CONNECTOR_AGENT_TYPE,
];

/**
 * The `api_keys.instance_id` a token minted for (client, human) carries —
 * `oauth:<client_id>:<user_id>`. It is the ONLY link from a minted key back to
 * the client that asked for it (the agent user is shared by every client the
 * same human connects), so the token endpoint writes it and the console's
 * client inventory (`oauthClients.*`) reads it through these two functions.
 * A `dcr_` client id is base64url and never contains `:`, but a CIMD client id
 * is an https URL that always does (`https://…`). A user id never does, so the
 * parse splits at the LAST `:`.
 */
const OAUTH_INSTANCE_PREFIX = "oauth:";

export function oauthKeyInstanceId(clientId: string, userId: string): string {
  return `${OAUTH_INSTANCE_PREFIX}${clientId}:${userId}`;
}

/** Every key minted for one client starts with this (`starts_with` on `instance_id`). */
export function oauthClientInstancePrefix(clientId?: string): string {
  return clientId === undefined
    ? OAUTH_INSTANCE_PREFIX
    : `${OAUTH_INSTANCE_PREFIX}${clientId}:`;
}

/** `oauthKeyInstanceId` read back; null for any other instance id. */
export function parseOauthKeyInstanceId(
  instanceId: string | null | undefined
): { clientId: string; userId: string } | null {
  if (!instanceId?.startsWith(OAUTH_INSTANCE_PREFIX)) return null;
  const rest = instanceId.slice(OAUTH_INSTANCE_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { clientId: rest.slice(0, cut), userId: rest.slice(cut + 1) };
}

/**
 * The Synap apps (spec 17 §6.2, verified tier v1): a pod app whose client_id
 * origin is EXACTLY `https://<id>.synap.live` for one of these ids is shown as
 * a "Synap app" on the consent screen; every other app is "Unverified". The
 * same exact-origin rule as the browser's hosted-app check, and the ids of the
 * Control Plane's built-in applications plus content-studio.
 */
export const SYNAP_APP_IDS = [
  "crm",
  "hub",
  "studio",
  "canvas",
  "devplane",
  "the-arch",
  "content-studio",
] as const;

/** Is this CIMD client_id a Synap app (exact-origin match, https only)? */
export function isSynapApp(clientId: string): boolean {
  let origin: string;
  try {
    origin = new URL(clientId).origin;
  } catch {
    return false;
  }
  return SYNAP_APP_IDS.some((id) => origin === `https://${id}.synap.live`);
}

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
 * `offline_access` is deliberately absent: an MCP client is issued no refresh
 * token, and a pod app gets one without asking (see
 * `buildAuthorizationServerMetadata`), so advertising it would be a lie a
 * client acts on.
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

/**
 * Functional default scope set for an MCP agent key — the same capability
 * surface as `INTEGRATION_HUB_SCOPES.custom`. An MCP agent drives the pod's
 * `/mcp` endpoint, which dispatches through the hub, so it needs both the
 * `mcp.*` scopes AND their `hub-protocol.*` peers to function end-to-end.
 */
export const MCP_CONNECT_DEFAULT_SCOPES: readonly ApiKeyScope[] = [
  "hub-protocol.read",
  "hub-protocol.write",
  "mcp.read",
  "mcp.write",
];

/**
 * Map requested scopes in either grammar — the CP's (`mcp:read`, colon) or the
 * pod's (`mcp.read`, dot) — to valid pod `api_keys` scopes, and ensure the
 * hub-protocol peer of each mcp scope is present so the minted key can actually
 * drive the pod's `/mcp` endpoint (MCP tool dispatch gates on the matching
 * `hub-protocol.*` scope). Unknown/invalid scopes are dropped; an empty result
 * falls back to the functional default set.
 *
 * Shared by both mint doors: `/token` (this AS) and the legacy `/mcp/redeem`.
 */
export function mapCpScopesToPodScopes(
  raw: readonly string[] | null | undefined
): ApiKeyScope[] {
  if (!raw || raw.length === 0) return [...MCP_CONNECT_DEFAULT_SCOPES];

  const mapped = new Set<ApiKeyScope>();
  for (const s of raw) {
    // CP grammar separates with ':' (mcp:read); pod grammar uses '.' (mcp.read).
    const normalized = s.replace(/:/g, ".").trim();
    if (isValidScope(normalized)) mapped.add(normalized);
  }

  // An MCP grant needs the matching hub-protocol scope to function (tool dispatch
  // rides the hub). Read implies hub-protocol.read; write implies both.
  if (mapped.has("mcp.read")) mapped.add("hub-protocol.read");
  if (mapped.has("mcp.write")) {
    mapped.add("hub-protocol.write");
    mapped.add("hub-protocol.read");
  }

  if (mapped.size === 0) return [...MCP_CONNECT_DEFAULT_SCOPES];
  return Array.from(mapped);
}

/** True when the registry row is this pod's APPROVED Control Plane. */
function isApprovedControlPlane(issuer: TrustedIssuer): boolean {
  return (
    issuer.status === "approved" &&
    Array.isArray(issuer.allowedScopes) &&
    CONTROL_PLANE_ISSUER_SCOPES.every((s) => issuer.allowedScopes.includes(s))
  );
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Which agent a `/token` grant mints for, decided by WHERE the code was
 * delivered: a redirect_uri on the origin of this pod's approved Control Plane
 * (`trusted_issuers`, status approved, holding the full
 * `CONTROL_PLANE_ISSUER_SCOPES` set — the same test every CP-only door uses)
 * is the CP connector; every other client is a direct one.
 *
 * Why the redirect origin and not the client's self-declared name: DCR is
 * public, so `client_name` is attacker-chosen, but the code is only ever
 * delivered to a registered https redirect_uri. A client that registers a CP
 * callback can never see its own code — the CP receives it and refuses the
 * unknown `state` — so claiming the CP's origin buys nothing.
 *
 * A failed registry read THROWS (the caller answers server_error): guessing
 * "direct" on a read error would silently mint the CP connector a key its
 * readers mis-render — the failure must stay visible.
 */
export async function resolveOAuthAgentType(
  redirectUri: string,
  issuers: Pick<TrustedIssuerService, "list"> = new TrustedIssuerService()
): Promise<OAuthAgentType> {
  const redirectOrigin = originOf(redirectUri);
  if (!redirectOrigin) return OAUTH_AGENT_TYPE;
  const approved = (await issuers.list()).filter(isApprovedControlPlane);
  return approved.some((i) => originOf(i.issuerUrl) === redirectOrigin)
    ? CP_CONNECTOR_AGENT_TYPE
    : OAUTH_AGENT_TYPE;
}
