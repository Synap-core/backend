/**
 * The Hub REST paths the auth middleware never authenticates: they read no
 * credential (public by design, or a capability in the path), or run their
 * own specialized check downstream. ONE list, read by `hubAuthMiddleware`
 * (auth.ts) and by the tripwire `credential-doors-refuse-device-session`,
 * which derives from it which Hub routes a Synap app's device token can
 * reach (every route but these). Pure: no import reaches the database.
 */

import {
  isPublicDoorPath,
  PUBLIC_PROJECTION_PATH,
} from "../../../public-doors.js";

// Public-by-design paths. `/openapi.json` and `/docs` are discovery
// surfaces — gating them behind auth defeats their purpose (Eve CLI
// and similar operators need to read the spec BEFORE they have a
// valid bearer to know what endpoints exist). `/health` is the
// standard liveness probe. `/entity-share/deliver` and `/setup/agent`
// use specialized auth (CP JWT and PROVISIONING_TOKEN respectively)
// and run their own checks downstream.
//
// Match logic: the request path arrives mounted under `/api/hub/...` (or the
// `/api/hub-protocol/...` alias). We strip the known mount prefix, then
// exact-compare the de-prefixed path against this list. Boundary-safe:
// a future route ending in `/health`, `/docs`, etc. is NOT silently skipped.
export const HUB_AUTH_SKIP_PATHS: readonly string[] = [
  "/health",
  "/openapi.json",
  // Static, no-DB agent orientation doc — public by design (same posture as
  // /openapi.json). Matched exactly as rel === "/manifest".
  "/manifest",
  "/docs",
  "/entity-share/deliver",
  "/setup/agent",
  // /setup/service uses the same specialized provisioning auth as /setup/agent
  // (trusted-issuer JWT / PROVISIONING_TOKEN / setup.agent-scoped or
  // hub-protocol.write key) — it runs its own checks downstream.
  "/setup/service",
  "/setup/status",
  "/setup/magic-link",
  "/setup/first-admin",
  // Invite acceptance — the invitee has no API key yet; token is the capability
  "/setup/accept-invite",
  // Public projection — an INTENTIONALLY unauthenticated, read-only surface for
  // a workspace's opt-in public data. Safe to expose without a key because the
  // handler is default-deny (404 unless settings.publicProjection.enabled ===
  // true), facet-workspace-scoped (never returns pod-wide private entities), and
  // field-whitelisted. (Kept OUTSIDE the credentialless public-door
  // namespace below — see `public-doors.ts`.)
  PUBLIC_PROJECTION_PATH,
  // CP→pod OIDC federation client push — authenticated by the CP's ISSUER
  // SIGNATURE (verifyIssuerJwt against the pinned trusted issuer), not an API
  // key. The handler runs its own verification.
  "/federation/oidc-config",
  // CP-MCP consent-code redeem — CP authenticates with a trusted-issuer JWT
  // (verifyTrustedIssuerJwt), NOT a hub API key: the CP-held pod credential is
  // a bootstrap secret, not a `synap_*` key, so it can't pass the key-format
  // middleware. The handler verifies the CP assertion + the one-time code.
  "/mcp/redeem",
  // CP-MCP disconnect revoke — same CP-trusted-issuer auth as /mcp/redeem,
  // scoped to its own `mcp_revoke` purpose claim (not replayable as a redeem).
  "/mcp/revoke",
  // The device door (RFC 8628, MACHINE-IDENTITY-PLAN W2): the terminal has
  // no credential yet — that is what it asks for. Create is IP-budgeted at
  // the edge (`device_auth`); collection is gated by the device code.
  "/setup/device",
  "/setup/device/token",
  // The holder's view of a key that may NOT authenticate (awaiting approval,
  // replaced, expired) — it reads the bearer itself and answers only about
  // the presented secret (`services/key-holder-state.ts`).
  "/auth/key-state",
];

/** The Hub mounts, longest first. */
const HUB_MOUNTS = ["/api/hub-protocol", "/api/hub"];

/**
 * `reqPath` without its Hub mount prefix (`/api/hub` or the
 * `/api/hub-protocol` alias), so the unprefixed entries match exactly; a path
 * under neither mount is returned as is.
 */
export function hubRelativePath(reqPath: string): string {
  const mount = HUB_MOUNTS.find(
    (m) => reqPath === m || reqPath.startsWith(m + "/")
  );
  return mount ? reqPath.slice(mount.length) || "/" : reqPath;
}

/** Does the auth middleware skip `reqPath` (the full, mounted path)? */
export function hubAuthSkipped(reqPath: string): boolean {
  const rel = hubRelativePath(reqPath);
  return (
    HUB_AUTH_SKIP_PATHS.includes(rel) ||
    // Credentialless public doors (`/public/*`, Sites W3): the capability is in
    // the path (a hashed share token) and NO credential is ever read — an
    // Authorization / X-Session-Token sent here is ignored, never resolved, so
    // it cannot change the response. The ONE predicate also drives the
    // idempotency skip, the transport CORS and the rate class.
    isPublicDoorPath(reqPath) ||
    // The pending-agent review/approve/reject subtree is token-protected (the
    // secret keyId IS the capability) and opened in a browser with no auth
    // header. Matched on the de-prefixed path — boundary-safe (no longer skips
    // a route that merely contains the substring).
    rel.startsWith("/setup/agent/pending/") ||
    // Personal ICS feed — token in the PATH is the capability. Prefix + `.ics`
    // so GET/POST `/calendar/feed` and POST `/calendar/feed/rotate` still
    // authenticate. Do not skip `/calendar` itself.
    (rel.startsWith("/calendar/feed/") && rel.endsWith(".ics"))
  );
}
