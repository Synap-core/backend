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

import { hubAuthMiddleware } from "./hub-protocol/_middleware/auth.js";
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

// ── Auth middleware ────────────────────────────────────────────────────────
//
// The implementation lives in `./hub-protocol/_middleware/auth.ts` so the
// door can be exercised directly by tests without instantiating the whole
// route tree. Mount position (immediately after the unauthenticated health
// routes, before the session + idempotency middleware) is unchanged.
app.use("/*", hubAuthMiddleware);

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
      // ── Unauthenticated setup/auth-bootstrap doors ───────────────────────
      // These fall to `userId = "anonymous"` (they are in `skipAuthPaths`), so
      // the cache key is NOT partitioned by a real user — a replayed
      // Idempotency-Key would serve one caller another caller's response.
      // `/setup/magic-link` is the sharpest: it returns `{ token, url }` where
      // `token` is a signed setup JWT (rest/setup.ts:1471), and the default
      // `secretBodyPattern` matches neither `token` nor `url`, so the
      // belt-and-suspenders body check does NOT save it either. `/mcp/redeem`
      // returns `apiKey` and is caught by that pattern — but one layer is not
      // a design. NEVER cache any of these.
      "/setup/magic-link",
      "/setup/first-admin",
      "/setup/accept-invite",
      "/federation/oidc-config",
      "/mcp/redeem",
      "/mcp/revoke",
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
