/**
 * Hub Protocol authentication middleware.
 *
 * EXTRACTED VERBATIM from `hub-protocol-rest.ts` (which now mounts it as
 * `app.use("/*", hubAuthMiddleware)`), so the door itself — not a re-derived
 * helper — can be exercised by tests. Behaviour and ordering are unchanged.
 *
 * Accepts two credential types:
 *   1. `Authorization: Bearer <api-key>` — IS agents, OpenClaw, CLI (API key auth)
 *   2. `X-Session-Token: <kratos-token>` — browser extension, web clients (Kratos session auth)
 *
 * Session-token callers receive full hub-protocol.read + hub-protocol.write scopes.
 * Skip auth for endpoints listed in skipAuthPaths.
 */

import type { Context, Next } from "hono";
import { createLogger } from "@synap-core/core";
import { db, users, eq } from "@synap/database";

import { apiKeyService } from "../../../services/api-keys.js";
import { resolveKeyIdentity } from "../../../access/key-identity.js";
import {
  isSubTokenFeatureEnabled,
  resolveExternalUserMapping,
} from "../../../services/external-user-mapping.js";
import { authErrorResponse, shortenKeyId } from "../../../utils/auth-error.js";
import type { HubVariables } from "../rest/_shared.js";

const logger = createLogger({ module: "hub-protocol-auth" });

/**
 * Attach near-expiry warning headers when a validated key is within this many
 * days of `expiresAt`. Pure addition — it does NOT change the hard-401-on-expiry
 * behavior (that stays in `getApiKeyStatus`, which returns `status: "expired"`).
 * The IS reads `X-Key-Expires-Soon` / `X-Key-Expires-At` on its responses (see
 * packages/jobs intelligence-health-check) to surface a re-provision warning.
 */
const KEY_EXPIRY_WARNING_DAYS = 14;

function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export const hubAuthMiddleware = async (
  c: Context<{ Variables: HubVariables }>,
  next: Next
) => {
  const reqPath = c.req.path;
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
  // exact-compare the de-prefixed path against `skipAuthPaths`. Boundary-safe:
  // a future route ending in `/health`, `/docs`, etc. is NOT silently skipped.
  const skipAuthPaths = [
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
    // /auth/exchange is the JWT-Bearer Grant primitive — auth happens via
    // the assertion JWT signature + the trusted_issuers allowlist, not via
    // an API key. Gating it behind the API-key middleware would break the
    // entire flow (callers don't have a key yet — that's why they're
    // exchanging).
    "/auth/exchange",
    // Invite acceptance — the invitee has no API key yet; token is the capability
    "/setup/accept-invite",
    // Public projection — an INTENTIONALLY unauthenticated, read-only surface for
    // a workspace's opt-in public data. Safe to expose without a key because the
    // handler is default-deny (404 unless settings.publicProjection.enabled ===
    // true), facet-workspace-scoped (never returns pod-wide private entities), and
    // field-whitelisted. It is the ONLY new unauth path.
    "/public/projection",
    // CP→pod OIDC federation client push — authenticated by the CP's ISSUER
    // SIGNATURE (verifyIssuerJwt against the pinned trusted issuer), not an API
    // key, exactly like /auth/exchange. The handler runs its own verification.
    "/federation/oidc-config",
    // CP-MCP consent-code redeem — CP authenticates with a trusted-issuer JWT
    // (verifyTrustedIssuerJwt), NOT a hub API key: the CP-held pod credential is
    // a bootstrap secret, not a `synap_*` key, so it can't pass the key-format
    // middleware. The handler verifies the CP assertion + the one-time code.
    "/mcp/redeem",
    // CP-MCP disconnect revoke — same CP-trusted-issuer auth as /mcp/redeem,
    // scoped to its own `mcp_revoke` purpose claim (not replayable as a redeem).
    "/mcp/revoke",
  ];
  // Strip the known mount prefix so the unprefixed `skipAuthPaths` entries can
  // be matched exactly. `reqPath` carries the mount prefix (`/api/hub` or the
  // `/api/hub-protocol` alias); a naive `===` against the unprefixed entries
  // would never match the mounted request.
  const HUB_MOUNTS = ["/api/hub-protocol", "/api/hub"]; // longest first
  const mount = HUB_MOUNTS.find(
    (m) => reqPath === m || reqPath.startsWith(m + "/")
  );
  const rel = mount ? reqPath.slice(mount.length) || "/" : reqPath;
  if (
    skipAuthPaths.includes(rel) ||
    // The pending-agent review/approve/reject subtree is token-protected (the
    // secret keyId IS the capability) and opened in a browser with no auth
    // header. Matched on the de-prefixed path — boundary-safe (no longer skips
    // a route that merely contains the substring).
    rel.startsWith("/setup/agent/pending/")
  ) {
    return next();
  }

  // ── 1. Try API key (agents / IS / OpenClaw) ─────────────────────────────
  const authHeader = c.req.header("authorization") ?? null;
  const token = extractBearerToken(authHeader);

  if (token) {
    // Use getApiKeyStatus (introspecting variant) so we can return a
    // structured failure reason — distinguishing revoked from expired
    // from unknown matters to operators trying to debug Eve CLI auth.
    const status = await apiKeyService.getApiKeyStatus(token);
    if (status.status === "invalid_format") {
      return authErrorResponse(c, "invalid_format");
    }
    if (status.status === "not_found") {
      // Either the key was never minted on this pod, or it was hard-revoked.
      // From the caller's perspective both look identical — collapse to
      // `key_revoked` with a hint that re-minting fixes it.
      return authErrorResponse(c, "key_revoked");
    }
    if (status.status === "revoked") {
      return authErrorResponse(c, "key_revoked", {
        keyIdPrefix: shortenKeyId(status.record.id),
      });
    }
    if (status.status === "expired") {
      return authErrorResponse(c, "expired", {
        keyIdPrefix: shortenKeyId(status.record.id),
      });
    }
    const keyRecord = status.record;
    // Match the legacy validateApiKey side effect: bump last_used_at /
    // usage_count (debounced internally to once per minute per key id).
    apiKeyService.recordKeyUse(keyRecord.id);

    // Near-expiry warning headers. Non-blocking — the request still succeeds;
    // expiry itself is enforced upstream (getApiKeyStatus → 401). Set before
    // next() so they persist onto whatever response the route handler emits.
    if (keyRecord.expiresAt) {
      const msLeft = keyRecord.expiresAt.getTime() - Date.now();
      if (msLeft <= KEY_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000) {
        c.header("X-Key-Expires-Soon", "true");
        c.header("X-Key-Expires-At", keyRecord.expiresAt.toISOString());
      }
    }

    const allowed = apiKeyService.checkRateLimit(keyRecord.id, "request");
    if (!allowed) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    // Default — pass-through. Used both as the "feature disabled" path and
    // as the safe fallback when the sub-token resolver fails for any reason.
    let resolvedUserId = keyRecord.userId;
    const resolvedScopes = keyRecord.scope;
    // TRUE only once the X-External-User-Id remap below has actually resolved
    // a mapping. This — not "the key has a linkedUserId" — is the honest signal
    // that `resolvedUserId` names an external end-user rather than the key
    // owner, and it is what the agent-identity remap further down must respect.
    let subTokenResolved = false;

    // Sub-token resolution — feature-flagged so existing single-key behavior
    // is the default. Anything other than the literal string "true" (incl.
    // unset) keeps the legacy behavior intact.
    //
    // IMPORTANT: skip the X-External-User-Id remap when the bearer is itself
    // a child key (Mode 2 — keyRecord.parentKeyId is set). The child key
    // already encodes the resolved Synap user; layering a header remap on
    // top would be ambiguous (whose user wins?) and would silently swap the
    // identity of legitimate child-key callers. The child key wins.
    if (isSubTokenFeatureEnabled() && !keyRecord.parentKeyId) {
      const externalUserId = c.req.header("x-external-user-id");
      if (externalUserId) {
        // The source label is optional metadata (best-effort hint for the
        // auto-created user). We don't fetch the parent agent's type here —
        // doing so would add a DB round-trip on every authenticated request.
        // The mapping row keeps `source: undefined` and the resolver writes a
        // generic fallback name; integrations that want richer attribution
        // can call POST /setup/external-user with a `name` instead.
        const mapping = await resolveExternalUserMapping(
          keyRecord.id,
          externalUserId,
          {
            parentOwnerUserId: keyRecord.userId,
          }
        );
        if (mapping) {
          resolvedUserId = mapping.synapUserId;
          subTokenResolved = true;
          c.set("parentKeyId", keyRecord.id);
          c.set("externalUserId", externalUserId);
        } else {
          // Lookup/create failed — never fail closed. Fall back to the
          // parent key's owner with a warning so operators can investigate.
          logger.warn(
            { parentKeyId: keyRecord.id, externalUserId },
            "Sub-token mapping unavailable — falling back to parent key owner"
          );
        }
      }
    } else if (
      isSubTokenFeatureEnabled() &&
      keyRecord.parentKeyId &&
      c.req.header("x-external-user-id")
    ) {
      // Mode 2 (child key) bearer + an X-External-User-Id header is a misuse —
      // log it once so operators can see drift between the pipeline mode and
      // the bearer it's actually sending. We do NOT remap (the child key
      // wins) and we don't 4xx the request (the child key is still valid).
      logger.warn(
        { childKeyId: keyRecord.id, parentKeyId: keyRecord.parentKeyId },
        "Child API key sent with X-External-User-Id header — header IGNORED (child key wins)"
      );
    }

    c.set("userId", resolvedUserId);
    c.set("scopes", resolvedScopes);
    // Expose the api_keys.id of the bearer that authenticated the request,
    // so /auth/status (and any future introspection routes) can look up
    // metadata about the calling key without re-running bcrypt.
    c.set("apiKeyId", keyRecord.id);
    // SERVICE-KEY WORKSPACE CONFINEMENT (Item 3): expose the key's type +
    // workspace binding so the shared caller-context door can positively pin a
    // bound `service` key to its workspace. Inert for every other key type.
    c.set("keyType", keyRecord.keyType);
    c.set("keyWorkspaceId", keyRecord.workspaceId ?? null);
    // Agent key identity remap — via the ONE door `resolveKeyIdentity`
    // (access/key-identity.ts). When a key has a linkedUserId (= the human who
    // created the agent), the human owns the entities (effectiveUserId), while the
    // acting agent principal is tracked as agentUserId for proposal attribution
    // across all Hub Protocol write handlers. agentUserId is derived from the
    // principal's `userType === 'agent'` (the ONE is-agent signal), NOT from "has
    // a linked human". The is_internal X-Delegated-Operator-Id remap below layers
    // on top of this base.
    //
    // GUARD — `!subTokenResolved`, NOT `linkedUserId`. `resolveKeyIdentity` reads
    // only the api_keys row (`linkedUserId ?? userId`); it has never seen
    // `resolvedUserId`, so under a resolved sub-token its effectiveUserId is the
    // KEY's human, and an unguarded `c.set("userId", …)` here overwrites the
    // external end-user the remap above just resolved. A previous version of this
    // comment claimed the `linkedUserId` check made that impossible — it does not:
    // it tests whether the key has a linked human, which is precisely the case a
    // parent agent key holding sub-token traffic is in (agent keys are minted WITH
    // a linkedUserId; the mint fails closed rather than null it). So the guard now
    // asks the only question that matters — did a sub-token actually resolve? —
    // and when one did we set NEITHER `userId` nor `linkedUserId`: this request
    // belongs to the external end-user, and leaving `linkedUserId` on the context
    // would invite downstream dual-writes (see `rest/memory.ts`) to file the
    // external user's data under the pod owner as well. Non-sub-token traffic is
    // unchanged: a linked key's writes still own as the human.
    const keyIdentity = await resolveKeyIdentity(keyRecord);
    if (keyRecord.linkedUserId && !subTokenResolved) {
      c.set("linkedUserId", keyRecord.linkedUserId);
      c.set("userId", keyIdentity.effectiveUserId); // human owns the entities
    }
    if (keyIdentity.agentUserId) {
      c.set("agentUserId", keyIdentity.agentUserId); // agent performed the action
    }

    // ── Trusted-IS operator-floor read delegation ───────────────────────────
    // The IS orchestrator reads the pod with its shared service key. Without a
    // remap, reads scope to the service identity ("system") instead of the
    // operator whose turn the IS is processing — so the agent sees 0 entities.
    //
    // SECURITY: this remap is gated EXCLUSIVELY on keyType === "is_internal" —
    // the trusted pod-read key minted only by the CP-JWT-gated provision handler
    // (apps/api/src/routers/provision.ts). A normal key (hub_inbound, user_pat,
    // service, …) that sends X-Delegated-Operator-Id is IGNORED: the header is
    // only read inside this branch, so it can never be triggered by a key that
    // isn't is_internal. WRITES STAY GOVERNED: agentUserId is set to the IS key
    // owner, so the write-gate routes agent mutations through proposals.
    if (keyRecord.keyType === "is_internal") {
      const op = c.req.header("x-delegated-operator-id");
      if (op) {
        // Validate the delegated operator names a real user on this pod before
        // trusting it as the read floor. Without this, an is_internal caller
        // could set an arbitrary header and read as any (or a non-existent) user.
        const operator = await db.query.users.findFirst({
          where: eq(users.id, op),
          columns: { id: true },
        });
        if (!operator) {
          return authErrorResponse(c, "no_auth", {
            message: "x-delegated-operator-id does not resolve to a pod user.",
          });
        }
        c.set("userId", op); // operator owns/sees the entities (data floor)
        // Attribute writes to the key owner ONLY if it's a real agent user. A
        // self-hosted IS key is owned by the "system" sentinel (no users row,
        // not userType='agent'), and setting it here made every write that
        // didn't carry its own body.agentUserId 400 ("invalid agentUserId").
        // Skip it for the sentinel: governed IS writes pass a real agentUserId
        // in the body (the acting agent); a write that omits it then falls back
        // to an operator-direct write, not the rejected "system".
        //
        // ATTRIBUTION (B1): we deliberately do NOT resolve the operator's
        // personal agent here to stamp agentUserId — doing so would flip
        // `checkPermissionOrPropose` from the operator's RBAC + legacy
        // `source:"intelligence"` path onto the AGENT governance ladder, and a
        // personal agent that isn't a member of the target workspace would then
        // file a `workspace.join` proposal instead of the intended write
        // (outcome change). Attribution is instead resolved inside
        // `createProposal` (permission-check.ts) AFTER the ladder has already
        // decided on the operator — so the OUTCOME is unchanged and only the
        // proposal's attributed agentUserId differs.
        if (keyRecord.userId && keyRecord.userId !== "system") {
          c.set("agentUserId", keyRecord.userId); // IS performed the action → proposals
        }
        c.set("linkedUserId", op);
      }
    }
    return next();
  }

  // ── 2. Try Kratos session token (browser extension / web clients) ────────
  const sessionToken = c.req.header("x-session-token");
  if (sessionToken) {
    try {
      const { getSession } = await import("@synap/auth");
      const headers = new Headers({ "x-session-token": sessionToken });
      const session = await getSession(headers);
      if (session?.identity?.id) {
        c.set("userId", session.identity.id as string);
        // Authenticated pod users get full hub-protocol scopes
        c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
        return next();
      }
    } catch (err) {
      logger.warn({ err }, "Session token validation failed");
    }
    // Session token was provided but rejected — surface as `key_revoked`
    // so the envelope reason set stays closed. (Session tokens are not
    // api_keys rows, but from the operator's perspective the failure mode
    // is the same: "your credential is no longer accepted".)
    return authErrorResponse(c, "key_revoked", {
      message:
        "Session token is invalid or expired. Re-authenticate via Better Auth.",
    });
  }

  return authErrorResponse(c, "no_auth");
};
