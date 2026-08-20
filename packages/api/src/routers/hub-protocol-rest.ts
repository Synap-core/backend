/**
 * Hub Protocol REST Adapter (B1)
 *
 * Exposes hub protocol procedures as REST endpoints for the Intelligence Service.
 * Uses API key auth (Bearer). Mount at /api/hub in the app.
 *
 * This file is the thin orchestrator — it owns:
 *   1. The Hono app instance + the auth middleware
 *   2. The exact registration order of every route slice (Hono is first-match,
 *      so the order in which registers are called must be preserved).
 *
 * Per-resource handlers live under `routers/hub-protocol/rest/*.ts`.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@synap-core/core";

import { db, users, eq } from "@synap/database";
import { apiKeyService } from "../services/api-keys.js";
import { resolveKeyIdentity } from "../access/key-identity.js";
import {
  isSubTokenFeatureEnabled,
  resolveExternalUserMapping,
} from "../services/external-user-mapping.js";
import { authErrorResponse, shortenKeyId } from "../utils/auth-error.js";
import { idempotencyMiddleware } from "./hub-protocol/_middleware/idempotency.js";
import { sessionMiddleware } from "./hub-protocol/_middleware/session.js";
import { AuthErrorEnvelopeSchema } from "./hub-protocol/rest/_codecs/auth.js";
import { registerOpenApiStubs } from "./hub-protocol/rest/_openapi-stubs.js";
import {
  type HubHono,
  registerAgentConfigsRoutes,
  registerAgentUsersRoutes,
  registerAgentsRoutes,
  registerAuthRoutes,
  registerExchangeRoutes,
  registerAutomationsRoutes,
  registerCapabilitiesRoutes,
  registerCapabilitiesCatalogRoutes,
  registerCapabilitiesActionsRoutes,
  registerCapabilitiesExecuteRoutes,
  registerCapabilityConnectionsRoutes,
  registerLoopsRoutes,
  registerCaptureRoutes,
  registerChannelsRoutes,
  registerChannelEgressRoutes,
  registerCommandsRoutes,
  registerDocumentsRoutes,
  registerEntitiesRoutes,
  registerEntityShareRoutes,
  registerEventsRoutes,
  registerHealthRoutes,
  registerHealthDependenciesRoutes,
  registerIdentityRoutes,
  registerKnowledgeRoutes,
  registerMcpServersRoutes,
  registerMemoryRoutes,
  registerNotificationsRoutes,
  registerProactiveRoutes,
  registerProfilesRoutes,
  registerProjectsRoutes,
  registerPackagesRoutes,
  registerProposalsRoutes,
  registerRelationsRoutes,
  registerLinksRoutes,
  registerRoutingRoutes,
  registerRelationDefsRoutes,
  registerSearchRoutes,
  registerSessionsRoutes,
  registerPlaybooksRoutes,
  registerSetupRoutes,
  registerMcpRedeemRoutes,
  registerSkillsRoutes,
  registerSkillsCrudRoutes,
  registerBriefsRoutes,
  registerToolsRoutes,
  registerTerminalRoutes,
  registerThreadsRoutes,
  registerUsersRoutes,
  registerVaultRoutes,
  registerViewsRoutes,
  registerWidgetDefinitionsRoutes,
  registerCellsRoutes,
  registerCellInstancesRoutes,
  registerWhiteboardsRoutes,
  registerWorkspacesRoutes,
  registerMessagingRoutes,
  registerDiscordRoutes,
  registerDiscordIdentityRoutes,
  registerConnectorsRoutes,
  registerWebhooksRoutes,
  registerSubscriptionsRoutes,
  registerManifestRoutes,
  registerDiscoverRoutes,
  registerOrientRoutes,
  registerPodConfigRoutes,
  registerPodAdoptRoutes,
  registerFederationRoutes,
  registerKeysRoutes,
  registerAiProvidersRoutes,
  registerFocusSessionsRoutes,
  registerAgentSkillsRoutes,
  registerRulesRoutes,
  registerUiRoutes,
  registerArtifactsRoutes,
  registerRunsRoutes,
  registerDiagnoseRoutes,
  registerWorkflowsRoutes,
  registerResolveRoutes,
  registerGraphRoutes,
  registerCentralityRoutes,
  registerObservabilityRoutes,
  registerPublicProjectionRoutes,
} from "./hub-protocol/rest/index.js";

const logger = createLogger({ module: "hub-protocol-rest" });

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

// HubVariables is exported from `./hub-protocol/rest/_shared.ts` and includes
// the optional `parentKeyId` / `externalUserId` keys populated by the
// sub-token resolver below (gated by HUB_PROTOCOL_SUB_TOKENS).
//
// `defaultHook` shapes Zod validation failures emitted by `app.openapi(...)`
// routes into the canonical `{ error: string }` envelope used by every other
// hub handler. Without it, @hono/zod-openapi returns the raw ZodError object,
// which differs from `ErrorSchema` and would make response shapes inconsistent
// across migrated vs non-migrated routes.
const app: HubHono = new OpenAPIHono<{
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  Variables: import("./hub-protocol/rest/_shared.js").HubVariables;
}>({
  defaultHook: (result, c) => {
    if (result.success) return;
    // Flatten Zod issues into a single human-readable string. The full issue
    // list is available in result.error.issues if a future debug surface
    // wants it; for now we mirror the existing inline format used by the
    // legacy handlers (e.g. "userId is required, fact is required").
    const message = result.error.issues
      .map((i) => {
        const path = i.path.join(".");
        return path ? `${path}: ${i.message}` : i.message;
      })
      .join(", ");
    return c.json({ error: message || "Validation failed" }, 400);
  },
});

// Register the bearer-auth security scheme used by every protected route.
// Per-route OpenAPI configs reference this by name via `security: [{ bearerAuth: [] }]`.
app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "API key",
  description:
    "Pod API key (Bearer) issued via /api/hub/setup/agent or pod admin tooling. " +
    "Browser/web clients may use the X-Session-Token header instead. " +
    "See GET /api/hub/auth/status to introspect the calling key.",
});

// ── Standardized 401 envelope (AuthErrorEnvelope) ──────────────────────────
//
// Every gated route inherits the 401 contract from the auth middleware (see
// `utils/auth-error.ts`). Registering the schema + a reusable response means
// per-route configs can `$ref: "#/components/responses/Unauthorized"` instead
// of repeating the shape. The envelope replaces the legacy `{ error: string }`
// response on auth failures while keeping the 401 status and the `error` key
// for backwards compatibility — see `utils/auth-error.ts` for the migration
// notes.
app.openAPIRegistry.register("AuthErrorEnvelope", AuthErrorEnvelopeSchema);
app.openAPIRegistry.registerComponent("responses", "Unauthorized", {
  description: "Auth failed. See `reason` field for the specific cause.",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/AuthErrorEnvelope" },
    },
  },
});

// ── Health (no auth, must register before middleware) ──────────────────────
registerHealthRoutes(app);

/**
 * Middleware: authenticate hub protocol requests.
 *
 * Accepts two credential types:
 *   1. `Authorization: Bearer <api-key>` — IS agents, OpenClaw, CLI (API key auth)
 *   2. `X-Session-Token: <kratos-token>` — browser extension, web clients (Kratos session auth)
 *
 * Session-token callers receive full hub-protocol.read + hub-protocol.write scopes.
 * Skip auth for endpoints listed in skipAuthPaths.
 */
app.use("/*", async (c, next) => {
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
    // a linked human". The userId override stays GUARDED by linkedUserId so it
    // never clobbers the X-External-User-Id sub-token remap above; the is_internal
    // X-Delegated-Operator-Id remap below layers on top of this base.
    const keyIdentity = await resolveKeyIdentity(keyRecord);
    if (keyRecord.linkedUserId) {
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
});

// ── Focus-session middleware ───────────────────────────────────────────────
//
// Reads the client-supplied `X-Session-Id` ONCE, VALIDATES that it names a
// focus session owned by the just-authenticated principal, and lands it on
// `c.set("sessionId")` (see `./hub-protocol/_middleware/session.ts` for the
// full security contract). Every route then inherits it through `getCaller`,
// instead of the four route files that used to read the raw header by hand.
//
// Mounted AFTER auth (it needs the resolved, remapped `userId`) and BEFORE
// idempotency — a replayed response is served without running the routes, and
// resolving a session for it would be a wasted round-trip.
app.use("*", sessionMiddleware);

// ── Idempotency middleware ─────────────────────────────────────────────────
//
// Opt-in HTTP `Idempotency-Key` support for all hub-protocol writes. Read more
// in `./hub-protocol/_middleware/idempotency.ts`. Summary:
//   - Header is OPT-IN. No header => pass-through. GET/HEAD/OPTIONS => pass-through.
//   - Cache key = (userId, idempotencyKey, sha256(body)). Same key + different
//     body => different entry, so a buggy retry can't be served a stale 200.
//   - 24h TTL. Only 2xx responses are cached (never 4xx/5xx).
//   - Replays come back with `X-Idempotent-Replay: true`.
//   - Fails OPEN on cache errors — never breaks the request.
//
// Skip list (E1.1 — must stay aligned with `skipAuthPaths` above):
//   - `/setup/agent` returns a one-shot `hubApiKey`. With no auth running
//     before idempotency, two operators replaying the same body + key would
//     receive the same cached secret. NEVER cache.
//   - `/entity-share/deliver` is authed via CP JWT (also skipAuthPaths) and
//     would fall back to `userId = "anonymous"` for the cache key — same
//     cross-tenant replay risk. NEVER cache.
//
// Belt & suspenders: the middleware also tests every 2xx response body
// against `secretBodyPattern` (default covers `hubApiKey`, `apiKey`,
// `subToken`, etc.) and skips caching when it matches.
//
// Mounted AFTER auth (needs `userId`) and BEFORE route slices.
app.use(
  "/*",
  idempotencyMiddleware({
    skipPaths: [
      "/setup/agent",
      // /setup/service returns a one-shot `serviceKey` secret — same
      // replay-a-cached-secret hazard as /setup/agent. NEVER cache.
      "/setup/service",
      "/entity-share/deliver",
      // /auth/exchange returns a Kratos session_token — same one-shot-secret
      // hazard as /setup/agent. Two replays of the same Idempotency-Key would
      // otherwise be served the same access_token from cache.
      "/auth/exchange",
    ],
    // secretBodyPattern uses the default — see middleware source.
  })
);

// ── Mount route slices in EXACTLY the original order ───────────────────────
//
// Hono is first-match: the order in which routes are registered matters when
// patterns can collide (e.g. /entities/:id/connections must come before
// /entities/:id, /sessions/active must come before /sessions/:sessionId, etc.).
// The route-file boundaries below are aligned with the original line order in
// the previous monolithic file so behavior is preserved character-for-character.
registerAuthRoutes(app); // /auth/status — bearer introspection
registerExchangeRoutes(app); // /auth/exchange — RFC 7523 JWT-Bearer Grant (no API-key auth)
registerUsersRoutes(app); // /users/me
registerWorkspacesRoutes(app); // /workspaces, /workspaces/:id/*, /users/:id/context
registerThreadsRoutes(app); // /threads* — combines GET-list, context, link, branches, messages, etc.
registerEventsRoutes(app); // /events
registerEntitiesRoutes(app); // /users/:id/entities + /entities*
registerIdentityRoutes(app); // /identity/resolve — read-only identity pre-check
registerCaptureRoutes(app); // /capture/*
registerSearchRoutes(app); // /search*, /vector-search
registerDocumentsRoutes(app); // /documents*
registerProposalsRoutes(app); // /proposals*
registerSkillsRoutes(app); // /skills/system (static doc)
registerBriefsRoutes(app); // GET /briefs (AI Teaching Substrate composed teaching briefs)
registerSkillsCrudRoutes(app); // POST/GET /skills (capability-substrate CRUD seam)
registerToolsRoutes(app); // POST/GET /tools, GET /tools/:id (capability-substrate CRUD seam)
registerCapabilitiesRoutes(app); // POST /capabilities/apply (capability-template applier)
registerCapabilitiesCatalogRoutes(app); // GET /capabilities/catalog (pack-grouped, status-computed cards)
registerCapabilitiesActionsRoutes(app); // GET /capabilities/actions (honestly executable action projection)
registerCapabilitiesExecuteRoutes(app); // POST /capabilities/execute (agnostic capability launcher)
registerCapabilityConnectionsRoutes(app); // GET/POST/PATCH/DELETE /capabilities/:capabilityId/connections (W4 connection CRUD)
registerLoopsRoutes(app); // POST /loops/apply (loop / autonomy-template applier)
registerMemoryRoutes(app); // /memory*
registerKnowledgeRoutes(app); // /knowledge*, /graph/traverse
registerCommandsRoutes(app); // /commands*, /commands/execute
registerAgentUsersRoutes(app); // /agent-users
registerAgentConfigsRoutes(app); // /agent-configs
registerViewsRoutes(app); // /views*
registerProfilesRoutes(app); // /profiles*, /property-defs*
registerProjectsRoutes(app); // /projects*
registerPackagesRoutes(app); // /packages*
registerRelationsRoutes(app); // /relations*
registerLinksRoutes(app); // /links (config/runtime graph; knowledge↔config bridge)
registerRoutingRoutes(app); // /routing (centralised knowledge-routing SSoT — P7b)
registerRelationDefsRoutes(app); // /relation-defs*
registerSessionsRoutes(app); // /sessions*, /compacted-states*
registerPlaybooksRoutes(app); // /playbooks/promote-from-session (governed)
registerWidgetDefinitionsRoutes(app); // /widget-definitions
registerCellsRoutes(app); // /cells, /cells/install, /cells/:typeKey
registerCellInstancesRoutes(app); // /cell-instances, /cell-instances/html, /cell-instances/:id*
registerWhiteboardsRoutes(app); // /whiteboards/:viewId/placements/propose
registerMcpServersRoutes(app); // /mcp-servers
registerAutomationsRoutes(app); // /automations*
registerVaultRoutes(app); // /vault/request
registerChannelsRoutes(app); // /channels/*
registerChannelEgressRoutes(app); // /channel-egress/pending, /channel-egress/:id/ack
registerTerminalRoutes(app); // /terminal/logs
registerProactiveRoutes(app); // /proactive/post
registerNotificationsRoutes(app); // /notifications
registerEntityShareRoutes(app); // /entity-share/deliver (CP JWT auth)
registerSetupRoutes(app); // /setup/agent (provisioning auth)
registerMcpRedeemRoutes(app); // /mcp/redeem (CP-MCP consent-code → claude-web key), /mcp/revoke (disconnect)
registerAgentsRoutes(app); // /agents/sync
registerMessagingRoutes(app); // /messaging/*
registerDiscordRoutes(app); // /discord/agent-turn
registerDiscordIdentityRoutes(app); // /discord/identity, /discord/identity/members, /discord/identity/link
registerConnectorsRoutes(app); // /connectors/*
registerWebhooksRoutes(app); // /webhooks
registerSubscriptionsRoutes(app); // /subscriptions*, /webhooks/:id/deliveries
registerManifestRoutes(app); // /manifest
registerDiscoverRoutes(app); // /discover
registerOrientRoutes(app); // /orient
registerPodConfigRoutes(app); // /pod/config
registerPodAdoptRoutes(app); // /pod/adopt
registerFederationRoutes(app); // /federation/oidc-config — CP→pod OIDC federation push
registerKeysRoutes(app); // /keys/rotate-cli
registerAiProvidersRoutes(app); // /ai-providers
registerFocusSessionsRoutes(app); // /focus-sessions*
registerAgentSkillsRoutes(app); // /agent-skills*
registerRulesRoutes(app); // /rules/classify (static, FIRST), /rules (create + list)
registerUiRoutes(app); // /ui/focus
registerArtifactsRoutes(app); // /artifacts*
registerRunsRoutes(app); // /runs/:runId/capture (playbook run capture-back)
registerDiagnoseRoutes(app); // /diagnose — the THIRD door (mode from payload shape)
registerWorkflowsRoutes(app); // /workflows/:kind/:id/place + /feed (workflow place)
registerResolveRoutes(app); // /resolve/:id — universal ID resolver
registerGraphRoutes(app); // /graph/:type/:id — object + typed neighbour graph
registerCentralityRoutes(app); // /centrality/status, /centrality/recompute — PageRank centrality window
registerObservabilityRoutes(app); // /observability/routing-health — decision/correction routing analysis
// /health/dependencies — AUTHENTICATED readiness probe (IS reachability).
// Deliberately registered HERE, after the auth middleware, and NOT next to the
// unauthenticated `/health` liveness probe above: it makes an outbound network
// call and discloses the resolved IS host. See the file header for the full
// argument for a second door over a `?deps=1` flag on /health.
registerHealthDependenciesRoutes(app);
registerPublicProjectionRoutes(app); // /public/projection — UNAUTH facet-scoped public read (skipAuthPaths)

// ── OpenAPI stubs for routes not yet annotated inline ──────────────────────
//
// High-priority routes (entities, threads, memory, knowledge) carry full Zod
// schemas inside their per-resource files. Everything else gets minimal
// metadata here so the spec at `/openapi.json` is at least discoverable
// without forcing schema design across all 95+ endpoints in one shot.
registerOpenApiStubs(app);

// ── OpenAPI doc endpoint (3.1) ─────────────────────────────────────────────
//
// `doc31` emits an OpenAPI 3.1 document. Routes registered via either
// `app.openapi(routeDef, handler)` OR
// `app.openAPIRegistry.registerPath(routeConfig)`
// appear here. Vanilla `app.get`/`app.post` calls are reachable but not
// documented — a deliberate trade-off so we can migrate incrementally.
app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "Synap Hub Protocol",
    version: "1.0.0",
    description:
      "REST surface for IS, agents, sidecars (OpenWebUI pipelines, OpenClaw), CLI, " +
      "and external integrations. Auth: Bearer API key OR X-Session-Token. " +
      "Idempotency-Key is supported on all writes.",
  },
  servers: [{ url: "/api/hub", description: "Pod-relative base URL" }],
  // Global security requirement — every operation inherits `bearerAuth`
  // unless it explicitly sets `security: []` (currently: /health, /openapi.json,
  // /docs, /entity-share/deliver, /setup/agent — all listed in `skipAuthPaths`
  // above and registered with `security: []` in their stubs/route defs).
  security: [{ bearerAuth: [] }],
});

// ── Swagger UI (DEV ONLY) ──────────────────────────────────────────────────
//
// Mounted only when NODE_ENV !== "production". The dynamic import keeps the
// swagger-ui bundle out of the production footprint when tree-shaking allows.
if (process.env.NODE_ENV !== "production") {
  import("@hono/swagger-ui")
    .then(({ swaggerUI }) => {
      app.get("/docs", swaggerUI({ url: "/api/hub/openapi.json" }));
    })
    .catch((err) => {
      logger.warn({ err }, "Failed to mount /docs (swagger-ui not available)");
    });
}

export const hubProtocolRestApp = app;
