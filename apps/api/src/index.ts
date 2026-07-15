/**
 * Synap API Server
 *
 * Hono server with:
 * - tRPC API endpoints
 * - Ory Kratos routes (session-based authentication)
 * - Token Exchange endpoint
 * - Federated trusted-issuer exchange endpoint (/api/federation/exchange)
 * - pg-boss job queue (background jobs)
 */

// Load environment variables from .env
import "dotenv/config";

// Initialize OpenTelemetry tracing FIRST (before any other imports)
// This must be done before importing any libraries to ensure proper instrumentation
// TODO: Enable tracing for production observability
// import { initializeTracing } from "@synap-core/core";
// initializeTracing();

import { Hono, type Context as HonoContext } from "hono";
import { HTTPException } from "hono/http-exception";

import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { getCookie } from "hono/cookie";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import {
  createLogger,
  config,
  isSynapError,
  toSynapError,
  validateConfig,
} from "@synap-core/core";
import {
  appRouter,
  createContext as createApiContext,
  hubProtocolRestApp,
  hubProtocolRouter,
  integrationsCapabilitiesApp,
  mcpHttpApp,
  fileUploadApp,
  externalSkillsApp,
  externalChatApp,
  chatStreamApp,
  openaiCompatApp,
  webhooksInboundRouter,
} from "@synap/api";
import { serve } from "@hono/node-server";
import {
  startBoss,
  stopBoss,
  registerAllWorkers,
  registerCronSchedules,
  startLocalSyncDriver,
  stopLocalSyncDriver,
} from "@synap/jobs";
import crypto from "crypto";
import {
  rateLimitMiddleware,
  aiRateLimitMiddleware,
  requestSizeLimit,
  handshakeRateLimitMiddleware,
} from "./middleware/security.js";
import { eventStreamManager, setupEventBroadcasting } from "@synap/api";
import {
  authMiddleware,
  configureLocalMode,
  safeTokenEqual,
} from "@synap/auth";
import { validateExplicitPodSessionToken } from "./explicit-pod-session.js";
import { buildKratosProxyTargetUrl } from "./kratos-proxy-url.js";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Setup event broadcasting to SSE clients
const apiLogger = createLogger({ module: "api-server" });
setupEventBroadcasting();
apiLogger.info("Event broadcasting initialized");

// ── Running-build version (for /status/release) ─────────────────────────────
// Reads the ACTUAL @synap/api package version off disk at runtime — this is the
// router code the pod is executing right now, so a stale/partial deploy shows a
// version that lags the repo. Resolved once and memoized. The exports map on
// @synap/api does NOT expose ./package.json, so we resolve the package main and
// walk up to the nearest package.json whose name matches.
const nodeRequire = createRequire(import.meta.url);
let cachedApiVersion: string | null | undefined;
function getRunningApiVersion(): string | null {
  if (cachedApiVersion !== undefined) return cachedApiVersion;
  try {
    let dir = dirname(nodeRequire.resolve("@synap/api"));
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "@synap/api") {
          cachedApiVersion = pkg.version ?? null;
          return cachedApiVersion;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through to null
  }
  cachedApiVersion = null;
  return cachedApiVersion;
}

// Validate configuration at startup
try {
  // Validate PostgreSQL database config
  validateConfig("postgres");
  apiLogger.info("PostgreSQL configuration validated");

  // Validate storage config only if explicitly set to R2
  // If R2 credentials are missing, provider will auto-switch to MinIO
  if (config.storage.provider === "r2") {
    // Only validate if we actually have R2 credentials
    // If not, the provider should have been auto-switched to MinIO
    if (
      config.storage.r2AccountId &&
      config.storage.r2AccessKeyId &&
      config.storage.r2SecretAccessKey
    ) {
      validateConfig("r2");
      apiLogger.info("R2 storage configuration validated");
    } else {
      // This shouldn't happen if auto-detection works, but log a warning
      apiLogger.warn(
        "R2 provider selected but credentials missing - should auto-switch to MinIO"
      );
    }
  } else {
    apiLogger.info(
      { provider: config.storage.provider },
      "Storage provider configured"
    );
  }

  // Validate AI config in production
  if (config.server.nodeEnv === "production") {
    validateConfig("ai");
    apiLogger.info("AI configuration validated");
  }

  // Validate Intelligence Hub config (warns in dev, throws in production if missing)
  validateConfig("intelligenceHub");
  apiLogger.info("Intelligence Hub configuration validated");

  // LOCAL_MODE mutual-exclusion: LOCAL_MODE=true and KRATOS_PUBLIC_URL must
  // not be set together — that would mean the operator forgot to remove Ory
  // config from the env, which could silently leave the auth path ambiguous.
  if (config.server.localMode && config.auth.kratosPublicUrl) {
    apiLogger.error(
      "LOCAL_MODE=true and KRATOS_PUBLIC_URL are both set. " +
        "These are mutually exclusive: remove KRATOS_PUBLIC_URL (and HYDRA_PUBLIC_URL) " +
        "when running in local mode."
    );
    process.exit(1);
  }

  // LOCAL_MODE requires LOCAL_AUTH_TOKEN — the Electron host generates and
  // passes this token; without it the pod cannot authenticate any request.
  if (config.server.localMode && !config.server.localAuthToken) {
    apiLogger.error(
      "LOCAL_MODE=true but LOCAL_AUTH_TOKEN is not set. " +
        "The Electron host must generate a token and pass it as LOCAL_AUTH_TOKEN."
    );
    process.exit(1);
  }

  // Validate Ory Stack (Kratos + Hydra) auth config.
  // In LOCAL_MODE this is a no-op (validateConfig branches on localMode).
  validateConfig("ory");
  if (config.server.localMode) {
    apiLogger.info("Local mode: Ory Stack auth bypassed (fixed-identity)");
  } else {
    apiLogger.info("Ory Stack configuration validated");
  }
} catch (error) {
  apiLogger.error({ err: error }, "Configuration validation failed");
  apiLogger.error(
    {
      error: error instanceof Error ? error.message : String(error),
    },
    "Please check your environment variables and configuration"
  );
  process.exit(1);
}

// Initialise local-mode state from Zod-validated config values.
// All auth paths (ory-middleware, ory-kratos, /api/session) read ONLY the
// module-level state set here — no raw process.env.LOCAL_MODE reads in auth paths.
configureLocalMode(config.server.localMode, config.server.localAuthToken);

// Initialize Hono app
const app = new Hono();

// CORS middleware — first-party allowlist plus owner-approved applications.
//
// Reflecting every origin together with Allow-Credentials is the textbook
// CSWSH/credentialed-CORS vulnerability (an attacker page can read any
// cookie-authed response cross-origin). Instead we echo the Origin back ONLY
// when it is a trusted first party. An exact browser origin explicitly
// approved by this Pod's owner gets a separate, credentialless CORS allowance.
// It is transport permission only: every Pod API still requires explicit local
// authentication and membership. Federation bootstrap endpoints are stricter:
// the exact application id in their URL must own the calling origin and is
// matched against the signed issuer assertion by the federation router.
//
// Must run first so error responses (429, 413) still carry CORS headers.
// Electron desktop (no Origin header) passes through untouched.
import {
  hasConfiguredOrigins,
  isAllowedOrigin,
  isApprovedApplicationOrigin,
  isApprovedApplicationOriginForClient,
  rejectsUnapprovedExternalPodApiRequest,
} from "./cors-origin.js";

if (!hasConfiguredOrigins() && process.env.NODE_ENV === "production") {
  apiLogger.warn(
    "[SECURITY] Neither SYNAP_BASE_DOMAIN nor ALLOWED_ORIGINS is set — all cross-origin browser requests will be denied. Set SYNAP_BASE_DOMAIN to your pod's base domain (e.g. example.com) so first-party surfaces (studio., app., …) can reach the pod."
  );
}

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  const firstPartyOrigin = Boolean(origin) && isAllowedOrigin(origin);
  const applicationExchangePath = c.req.path === "/api/federation/exchange";
  const applicationFederationPath =
    applicationExchangePath || c.req.path === "/api/federation/identity-links";
  const approvedApplicationOrigin =
    Boolean(origin) &&
    !firstPartyOrigin &&
    (applicationFederationPath
      ? await isApprovedApplicationOriginForClient(
          origin,
          c.req.query("application_id"),
          c.req.query("issuer_url")
        )
      : await isApprovedApplicationOrigin(origin));
  if (origin && (firstPartyOrigin || approvedApplicationOrigin)) {
    c.header("Access-Control-Allow-Origin", origin);
    if (firstPartyOrigin) {
      c.header("Access-Control-Allow-Credentials", "true");
    }
    c.header("Vary", "Origin");
    c.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    );
    c.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Cookie, X-Workspace-Id, X-Session-Token"
    );
    c.header(
      "Access-Control-Expose-Headers",
      "Content-Length, X-Request-Id, Set-Cookie"
    );
    c.header("Access-Control-Max-Age", "86400");
  }

  const applicationConnectionPath = c.req.path.startsWith(
    "/api/federation/application-connections/"
  );
  // CORS headers govern what a browser may read, not whether it can send a
  // cached-preflight request. Enforce revocation at the server boundary too:
  // an unapproved external origin cannot call any normal Pod API, even while
  // the browser still remembers a previous preflight response. The narrow
  // opaque application-connection routes own their separate capability and
  // CORS checks below.
  if (
    rejectsUnapprovedExternalPodApiRequest({
      origin,
      firstPartyOrigin,
      approvedApplicationOrigin,
      path: c.req.path,
      method: c.req.method,
    })
  ) {
    return c.json(
      { error: "This browser origin is not approved for this Pod" },
      403
    );
  }
  // An owner-approved external origin is allowed to use an explicit Pod token
  // for normal APIs. It must never fall back to an ambient Kratos cookie:
  // CORS does not stop a cross-site request from being sent, only from being
  // read. Bootstrap and opaque continuation routes have their own assertion /
  // capability checks and intentionally do not carry this session token.
  const requiresExplicitPodToken =
    approvedApplicationOrigin &&
    !firstPartyOrigin &&
    !applicationExchangePath &&
    !applicationConnectionPath &&
    c.req.method !== "OPTIONS";
  if (requiresExplicitPodToken) {
    const tokenStatus = await validateExplicitPodSessionToken(
      c.req.header("x-session-token")
    );
    if (tokenStatus !== "valid") {
      return c.json(
        {
          error:
            tokenStatus === "unavailable"
              ? "Pod authentication is temporarily unavailable"
              : "An explicit X-Session-Token is required for an external application origin",
        },
        tokenStatus === "unavailable" ? 503 : 401
      );
    }
    // Downstream auth middleware re-validates the token in strict mode. This
    // closes the race between this transport guard and an ordinary middleware
    // fallback to a SameSite=None Kratos cookie.
    c.set("requireExplicitSessionToken" as never, true);
  }

  // The application-connection completion routes use a narrower,
  // credentialless per-request CORS policy inside the federation router. They
  // cannot use this global first-party allowlist because a self-hosted Pod may
  // have just approved an exact external app origin. Let those OPTIONS calls
  // reach the route-level validator; every other preflight stays fail-closed.
  const applicationConnectionPreflight =
    c.req.method === "OPTIONS" &&
    /^\/api\/federation\/application-connections\/requests\/[^/]+\/(?:status|complete)$/.test(
      c.req.path
    );
  if (applicationConnectionPreflight) return next();

  // Preflight always gets a 204; a disallowed origin simply receives no ACAO
  // header above, so the browser blocks the actual request.
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  return next();
});

// Security Middleware
app.use("*", requestSizeLimit); // Max 10MB requests
app.use("*", rateLimitMiddleware); // 500 req/15min per IP
app.use("*", secureHeaders()); // Hono built-in security headers
apiLogger.info("Security middleware registered");

// HTTP Cache Headers — allow short browser caching for GET (query) requests,
// no caching for POST (mutation) requests. Simple single-instance optimization.
app.use("*", async (c, next) => {
  await next();
  if (c.req.method === "GET") {
    // Allow private (browser-only) caching for 60 seconds on read requests.
    // stale-while-revalidate lets the browser use a stale response while fetching fresh data.
    if (!c.res.headers.has("Cache-Control")) {
      c.header(
        "Cache-Control",
        "private, max-age=60, stale-while-revalidate=30"
      );
    }
  } else {
    c.header("Cache-Control", "no-store");
  }
});

// Logging
app.use("*", logger());

// Health check (public, no auth)
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.2.0-saas",
    // Published `@synap-core/api-types` version this pod's router was built
    // against. Clients compare its major via `assertApiTypesCompatible()` to
    // detect stale pinned types. Kept in sync with
    // packages/api-types/package.json#version by
    // packages/api-types/scripts/check-and-bump.mjs — do not hand-edit.
    apiTypesVersion: "1.21.1",
    mode: "multi-user",
    auth: "ory-stack",
  });
});

// Root (direct :4000 / dev without Caddy): not the admin SPA — that lives at /admin/
app.get("/", (c) => {
  return c.json({
    service: "Synap Data Pod API",
    adminConsole: "/admin/",
    health: "/health",
    docs: "https://docs.synap.live",
  });
});

// Prometheus metrics endpoint (public, no auth)
app.get("/metrics", async (c) => {
  const { getMetrics } = await import("@synap-core/core");
  const metrics = await getMetrics();
  return c.text(metrics, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
  });
});

// ── Deploy verification (public, no auth) ──────────────────────────────────
// GET /status/release answers "is the latest actually deployed, and did the
// migration apply?" in one call. Every lookup is wrapped so a missing table or
// failed check degrades to null + a note — it never 500s. Kept OUT of /health
// so the liveness probe stays cheap and its api-types compat literal is
// untouched.
app.get("/status/release", async (c) => {
  // version — the running @synap/api build (off disk, not a literal)
  const version = getRunningApiVersion();

  // migrations — the hand-written migration ledger (_migrations, public schema)
  let migrations: {
    lastApplied: string | null;
    lastAppliedAt: string | null;
    count: number;
    note?: string;
  } = { lastApplied: null, lastAppliedAt: null, count: 0 };
  try {
    const { sql } = await import("@synap/database");
    const rows = await sql<Array<{ filename: string; applied_at: string }>>`
      SELECT filename, applied_at
        FROM _migrations
       ORDER BY applied_at DESC, id DESC
    `;
    migrations = {
      lastApplied: rows[0]?.filename ?? null,
      lastAppliedAt: rows[0]?.applied_at
        ? new Date(rows[0].applied_at).toISOString()
        : null,
      count: rows.length,
    };
  } catch (err) {
    migrations = {
      lastApplied: null,
      lastAppliedAt: null,
      count: 0,
      note: `Could not read _migrations: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // schemaCoherence — reuse the pod-startup drift validator (one query)
  let schemaCoherence: {
    ok: boolean | null;
    drift: Array<{ table: string; column: string; addedBy: string }>;
    checked?: number;
    note?: string;
  } = { ok: null, drift: [] };
  try {
    const { checkSchemaCoherence } = await import("@synap/database");
    const result = await checkSchemaCoherence();
    schemaCoherence = {
      ok: result.ok,
      drift: result.missing.map((m) => ({
        table: m.table,
        column: m.column,
        addedBy: m.addedBy,
      })),
      checked: result.checked,
    };
  } catch (err) {
    schemaCoherence = {
      ok: null,
      drift: [],
      note: `Coherence check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  // buildStamp — the git commit the running image was built from, stamped in
  // at image-build time via `docker build --build-arg GIT_SHA=$(git rev-parse HEAD)`
  // (deploy/Dockerfile ARG GIT_SHA -> ENV SYNAP_GIT_SHA). null when the image
  // was built/pulled without that arg (older images, registry pulls that
  // predate this change) — reported as null rather than fabricated.
  const buildStamp: string | null = process.env.SYNAP_GIT_SHA || null;

  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version,
    migrations,
    schemaCoherence,
    buildStamp,
  });
});

// ─── Legacy /admin/connect → pod-admin/connect redirect ───────────────
//
// The legacy admin-ui SPA at `pod.<root>/admin/*` was retired in the
// 2026-05 auth refactor; the connect surface moved to pod-admin's
// native `/connect` page on the `pod-admin.<root>` subdomain.
//
// In-the-wild Synap CLI / Raycast / OpenClaw installs still build URLs
// against `${podUrl}/admin/connect?integration=…&redirect_uri=…`. We
// 302 those to the new home so existing installs keep working without
// a CLI/Raycast upgrade. Future releases of those clients should target
// `pod-admin.<root>/connect` directly via
// `buildIntegrationConnectUrl()` in `@synap-core/external-connect-client`.
app.get("/admin/connect", (c) => {
  const host = c.req.header("host") ?? "";
  const proto = c.req.header("x-forwarded-proto") ?? "https";
  const url = new URL(c.req.url);

  // Production: `pod.<root>` → `pod-admin.<root>`. Anything else (raw
  // IP, localhost, custom CNAME) falls back to the dev pod-admin port.
  let target: string;
  if (host.startsWith("pod.")) {
    const root = host.slice("pod.".length).replace(/:\d+$/, "");
    target = `${proto}://pod-admin.${root}/connect${url.search}`;
  } else if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
    target = `http://localhost:4040/connect${url.search}`;
  } else {
    // Best effort: assume `<sub>.<root>` and swap `<sub>` → `pod-admin`.
    const dot = host.indexOf(".");
    const root =
      dot > 0
        ? host.slice(dot + 1).replace(/:\d+$/, "")
        : host.replace(/:\d+$/, "");
    target = `${proto}://pod-admin.${root}/connect${url.search}`;
  }

  return c.redirect(target, 302);
});

// ── Deep-link bounce (public, no auth) ──────────────────────────────────────
// An https URL — clickable anywhere (Discord, email, chat) — that forwards into
// the Electron app via its registered `synap://` protocol. Discord (and most
// chat clients) will NOT linkify a raw `synap://` URL, so we serve a tiny https
// page that immediately redirects to it. The app's deep-link handler
// (`useDeepLinkHandler.ts`) understands `synap://open/<type>/<id>` for
// proposal | entity | view | document | cell | channel. No auth here: this only forwards a
// scheme; the target surface is access-gated inside the app.
// Renders the tiny https page that immediately redirects to the given
// `synap://` deep link. `deep` contains only validated/known-safe chars, so it
// interpolates into href/JS without escaping concerns. If the app isn't
// installed the redirect is a no-op, so after a short delay we reveal a
// fallback block (with a manual retry link) rather than stranding the user on
// "Opening…" forever.
function renderDeepLinkPage(deep: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Opening in Synap…</title>` +
    `<script>location.replace(${JSON.stringify(deep)});` +
    `setTimeout(function(){var f=document.getElementById('fallback');if(f)f.style.display='block';},1500);</script>` +
    `<style>html,body{height:100%}body{margin:0;font-family:system-ui,-apple-system,sans-serif;` +
    `background:#0b0b0c;color:#e9e9ec;display:flex;align-items:center;justify-content:center}` +
    `a{color:#10b981}main{text-align:center;max-width:24rem;padding:2rem}` +
    `h1{font-size:1rem;font-weight:500;margin:0}` +
    `.spinner{width:1.5rem;height:1.5rem;margin:0 auto 1rem;border-radius:50%;` +
    `border:2px solid #2a2a2e;border-top-color:#10b981;animation:spin .8s linear infinite}` +
    `#fallback{display:none;margin-top:1.5rem;font-size:.875rem;color:#a1a1aa}` +
    `#fallback a{text-decoration:underline}` +
    `@keyframes spin{to{transform:rotate(360deg)}}` +
    `@media (prefers-reduced-motion:reduce){.spinner{animation:none}}</style>` +
    `</head><body><main>` +
    `<div class="spinner" aria-hidden="true"></div>` +
    `<h1 role="status" aria-live="polite">Opening in Synap…</h1>` +
    `<div id="fallback"><p>Didn't open? Make sure the Synap app is installed.</p>` +
    `<p><a href="${deep}">Open in Synap</a></p></div>` +
    `</main></body></html>`
  );
}

app.get("/open/:type/:id", (c) => {
  // `project` / `workspace` are lens targets (not rows the app "opens" as a
  // surface) — the browser deep-link handler switches the active lens and lands
  // on that lens's home dashboard. Backs clickable statusline links (synap-cli).
  const ALLOWED = new Set([
    "proposal",
    "entity",
    "view",
    "document",
    "cell",
    "project",
    "workspace",
  ]);
  const type = c.req.param("type");
  const id = c.req.param("id");
  // id is a UUID or a cell typeKey — allow only url/HTML-safe chars so it can be
  // interpolated into href/JS without escaping concerns.
  if (!ALLOWED.has(type) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return c.text("Invalid deep link", 400);
  }
  return c.html(renderDeepLinkPage(`synap://open/${type}/${id}`));
});

// ── Canonical bare-id deep-link bounce (public, no auth) ─────────────────────
// The one link shape every create/propose response emits: `${PUBLIC_URL}/open/
// <id>` (see packages/api/src/utils/deep-links.ts). We resolve the id's type
// here — probing proposal → entity → view → document (same order as
// hub-protocol/rest/resolve.ts) — then serve the same bounce page to
// `synap://open/<type>/<id>`. This is a public id→type map ONLY, so it uses a
// service DB handle (no user API key); the target surface is access-gated inside
// the app. Unknown ids gracefully bounce to `synap://open/<id>`.
app.get("/open/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return c.text("Invalid deep link", 400);
  }
  const { getDb, eq } = await import("@synap/database");
  const { proposals, entities, views, documents, channels } =
    await import("@synap/database/schema");
  const database = await getDb();

  const exists = async (query: () => Promise<unknown[]>): Promise<boolean> => {
    try {
      const [row] = await query();
      return Boolean(row);
    } catch {
      return false;
    }
  };

  let type: string | undefined;
  if (
    await exists(() =>
      database
        .select({ id: proposals.id })
        .from(proposals)
        .where(eq(proposals.id, id))
        .limit(1)
    )
  ) {
    type = "proposal";
  } else if (
    await exists(() =>
      database
        .select({ id: entities.id })
        .from(entities)
        .where(eq(entities.id, id))
        .limit(1)
    )
  ) {
    type = "entity";
  } else if (
    await exists(() =>
      database
        .select({ id: views.id })
        .from(views)
        .where(eq(views.id, id))
        .limit(1)
    )
  ) {
    type = "view";
  } else if (
    await exists(() =>
      database
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, id))
        .limit(1)
    )
  ) {
    type = "document";
  } else if (
    await exists(() =>
      database
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.id, id))
        .limit(1)
    )
  ) {
    // Channels back post_message / get_channel links; the browser deep-link
    // handler opens `synap://open/channel/<id>` in the main panel.
    type = "channel";
  }

  const deep = type ? `synap://open/${type}/${id}` : `synap://open/${id}`;
  return c.html(renderDeepLinkPage(deep));
});

// Ory Kratos routes
// Kratos handles its own routes via public API
// We proxy the necessary endpoints for browser-based flows
// This matches Caddy routing in production: /.ory/kratos/public/* -> Kratos
const kratosPublicUrl =
  process.env.KRATOS_PUBLIC_URL || "http://localhost:4433";

// Proxy function for Kratos requests
const proxyKratosRequest = async (c: HonoContext, kratosPath: string) => {
  try {
    // Forward request to Kratos public API
    const targetUrl = buildKratosProxyTargetUrl(
      kratosPublicUrl,
      kratosPath,
      c.req.url
    );

    // Prepare headers - forward cookies and other important headers
    const headers: Record<string, string> = {
      Cookie: c.req.header("cookie") || "",
    };

    // Forward content-type if present
    const contentType = c.req.header("content-type");
    if (contentType) {
      headers["Content-Type"] = contentType;
    }

    // Forward Accept header — critical for Kratos to return JSON for API flows
    // Without this, some Kratos versions may default to browser-flow behavior
    const accept = c.req.header("accept");
    if (accept) {
      headers["Accept"] = accept;
    }

    // Forward X-Session-Token if present (for API-flow token auth)
    const sessionToken = c.req.header("x-session-token");
    if (sessionToken) {
      headers["X-Session-Token"] = sessionToken;
    }

    // Get request body for POST/PUT/PATCH
    let body: string | undefined;
    if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
      const contentType = c.req.header("content-type");
      if (contentType?.includes("application/json")) {
        body = JSON.stringify(await c.req.json());
      } else {
        body = await c.req.text();
      }
    }

    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers,
      body,
      redirect: "manual",
    });

    // Build a Headers object. Set-Cookie needs special handling because
    // Kratos sets two cookies per flow (the flow cookie + csrf_token cookie),
    // and iterating headers naively combines them into one comma-joined line
    // that browsers cannot parse — which kills CSRF and every subsequent POST
    // fails with 400.
    const outHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      outHeaders.set(key, value);
    });
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const cookie of setCookies) outHeaders.append("set-cookie", cookie);

    return c.newResponse(response.body, {
      status: response.status as 200,
      headers: outHeaders,
    });
  } catch (error) {
    apiLogger.error(
      { err: error, path: kratosPath },
      "Error proxying Kratos request"
    );
    return c.json({ error: "Internal server error" }, 500);
  }
};

// Route: /.ory/kratos/public/* (matches Caddy handle_path routing)
// Caddy strips the /.ory/kratos/public prefix before forwarding to backend,
// so Kratos internally sees /self-service/... paths directly.
app.all("/.ory/kratos/public/*", async (c) => {
  if (config.server.localMode) {
    return c.json(
      { error: "Kratos routes are not available in local mode" },
      404
    );
  }
  const kratosPath = c.req.path.replace("/.ory/kratos/public", "");
  return proxyKratosRequest(c, kratosPath);
});

// Legacy route: /self-service/* (for backward compatibility)
app.all("/self-service/*", async (c) => {
  if (config.server.localMode) {
    return c.json(
      { error: "Kratos routes are not available in local mode" },
      404
    );
  }
  const kratosPath = c.req.path.replace("/self-service", "");
  return proxyKratosRequest(c, kratosPath);
});

// Token Exchange endpoint (for websites with external providers)
app.post("/api/auth/token-exchange", async (c) => {
  try {
    const body = await c.req.json();

    // Validate request body
    if (!body.subject_token) {
      return c.json({ error: "subject_token is required" }, 400);
    }

    const { exchangeToken } = await import("@synap/auth");

    const result = await exchangeToken({
      subject_token: body.subject_token,
      subject_token_type:
        body.subject_token_type ||
        "urn:ietf:params:oauth:token-type:access_token",
      client_id: body.client_id,
      client_secret: body.client_secret,
      requested_token_type:
        body.requested_token_type ||
        "urn:ietf:params:oauth:token-type:access_token",
      scope: body.scope,
    });

    if (!result) {
      return c.json({ error: "Token exchange failed" }, 400);
    }

    return c.json(result);
  } catch (error) {
    apiLogger.error({ err: error }, "Error in token exchange");
    return c.json({ error: "Token exchange failed" }, 500);
  }
});

/**
 * This product-specific endpoint intentionally has no compatibility path.
 * The generic trusted-issuer protocol lives at `/api/federation/exchange`.
 * Refusing legacy payloads prevents the Pod from regaining external product
 * assumptions through a deprecated route.
 */
app.use("/api/handshake", handshakeRateLimitMiddleware);
app.post("/api/handshake", (c) =>
  c.json(
    {
      error: "This endpoint has been retired. Use /api/federation/exchange.",
      code: "FEDERATION_HANDSHAKE_RETIRED",
    },
    410
  )
);

// The canonical router receives the same rate limit before it is mounted
// farther below at `/api/federation`.
app.use("/api/federation/exchange", handshakeRateLimitMiddleware);
app.use("/api/federation/bootstrap", handshakeRateLimitMiddleware);
app.use(
  "/api/federation/application-connections/*",
  handshakeRateLimitMiddleware
);

// Session check endpoint — used by the web landing page (synap.dev) to determine
// if the user already has a valid Pod session after a previous federated
// exchange, so it does not need to create another session on every page load.
//
// Auth: ory_kratos_session cookie (set by the native or federated login flow).
// Returns 200 + session data if valid, 401 if missing or expired.
app.get("/api/session", async (c) => {
  // LOCAL MODE: validate the bearer/x-local-token and return the fixed identity.
  // Only bearer + x-local-token are accepted — ory_kratos_session cookie is
  // NOT a valid LOCAL_MODE token channel.
  if (config.server.localMode) {
    const authHeader = c.req.header("Authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : "";
    const incomingToken = bearerToken || c.req.header("x-local-token") || "";

    if (
      !incomingToken ||
      !config.server.localAuthToken ||
      !safeTokenEqual(incomingToken, config.server.localAuthToken)
    ) {
      return c.json({ authenticated: false }, 401);
    }

    const { buildLocalApiSession } = await import("@synap/auth");
    return c.json(buildLocalApiSession());
  }

  const sessionToken = getCookie(c, "ory_kratos_session");
  if (!sessionToken) {
    return c.json({ authenticated: false }, 401);
  }

  try {
    const resp = await fetch(`${kratosPublicUrl}/sessions/whoami`, {
      headers: {
        Cookie: `ory_kratos_session=${sessionToken}`,
        Accept: "application/json",
      },
    });

    if (!resp.ok) {
      return c.json({ authenticated: false }, 401);
    }

    const session = await resp.json();
    return c.json({ authenticated: true, session });
  } catch (err) {
    apiLogger.error({ err }, "Session check failed");
    return c.json({ authenticated: false }, 401);
  }
});

if (config.server.localMode) {
  apiLogger.info(
    "Local mode: Ory Kratos routes respond 404 at /.ory/kratos/public/* and /self-service/*"
  );
} else {
  apiLogger.info(
    "Ory Kratos routes enabled at /.ory/kratos/public/* and /self-service/*"
  );
}
apiLogger.info("Token Exchange endpoint enabled at /api/auth/token-exchange");
apiLogger.info(
  "Federated issuer exchange endpoint enabled at /api/federation/exchange; legacy /api/handshake returns 410"
);

// SSE endpoint for real-time event streaming (admin dashboard)
// Server-Sent Events endpoint for event broadcasting
app.get("/api/events/stream", (c) => {
  const clientId = crypto.randomUUID();

  const stream = new ReadableStream({
    start(controller) {
      // Register the client
      eventStreamManager.registerClient(clientId, controller);

      // Send initial connection message
      const encoder = new TextEncoder();
      const initialMessage = `data: ${JSON.stringify({ type: "connected", clientId })}\n\n`;
      controller.enqueue(encoder.encode(initialMessage));

      apiLogger.info({ clientId }, "SSE client stream started");
    },
    cancel() {
      // Cleanup when client disconnects
      eventStreamManager.unregisterClient(clientId);
      apiLogger.info({ clientId }, "SSE client stream cancelled");
    },
  });

  // Echo the caller's origin only when it's a trusted first party (same policy
  // as the global CORS middleware) — never `*`-with-credentials.
  const sseOrigin = c.req.header("origin");
  const sseHeaders: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (sseOrigin && isAllowedOrigin(sseOrigin)) {
    sseHeaders["Access-Control-Allow-Origin"] = sseOrigin;
    sseHeaders["Access-Control-Allow-Credentials"] = "true";
    sseHeaders["Vary"] = "Origin";
  }

  // Return SSE stream using Hono's newResponse
  // c.newResponse(body, status, headers) signature
  return c.newResponse(stream, 200, sseHeaders);
});

// tRPC routes — apply session auth for all routes except health.* and setup.*
// system.* procedures enforce their own auth level (protectedProcedure / podAdminProcedure)
app.use("/trpc/*", async (c, next) => {
  const path = c.req.path;

  // health.*, setup.*, and invite-preview/accept are always public
  if (
    path.includes("health.") ||
    path.includes("setup.") ||
    path.includes("workspaces.previewInvite") ||
    path.includes("workspaces.acceptInviteViaCp")
  ) {
    return next();
  }

  // Everything else requires a valid Kratos session
  return authMiddleware(c, next);
});

// WebSocket ticket minting (see ws-auth.ts for the CSWSH rationale). The browser
// exchanges its authenticated session for a short-lived, single-use ticket, then
// opens terminal WebSockets with `?ticket=`.
import { issueWsTicket } from "./ws-auth.js";

// The /api/ws-ticket mint endpoint reuses the global first-party origin policy
// (cors-origin.ts): a cross-origin page cannot mint a ticket from an untrusted
// origin, even though the request carries the session cookie.
app.post("/api/ws-ticket", authMiddleware, async (c) => {
  const origin = c.req.header("origin");
  if (origin && !isAllowedOrigin(origin)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  // `app` is an untyped Hono instance, so the context Variables map isn't known
  // to TS — but authMiddleware (which runs before this handler) sets `userId` to
  // the authenticated identity id (string). Read it with an explicit type.
  const userId = c.get("userId" as never) as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  return c.json(issueWsTicket(userId));
});

// AI Providers — public model discovery for the synap CLI (keys never returned)
import { providersRouter } from "./routers/providers.js";
app.route("/api/hub/providers", providersRouter);

// Automations schema — static reference document for trigger types, node types, CLI flags
import { automationsSchemaRouter } from "./routers/automations-schema.js";
app.route("/api/hub/automations/schema", automationsSchemaRouter);

// Connectors schema — static reference document for connector providers, CLI commands, REST endpoints
import { connectorsSchemaRouter } from "./routers/connectors-schema.js";
app.route("/api/hub/connectors/schema", connectorsSchemaRouter);

// Admin routes (public API for invitations)
import { adminRouter } from "./routers/admin.js";
app.route("/api/admin", adminRouter);

// Admin source configs (CP-provisioned feed source configurations — ES256 JWT auth)
import { adminSourceConfigsRouter } from "@synap/api";
app.route("/api/admin/source-configs", adminSourceConfigsRouter);

// Legacy provisioning integration endpoints. New external identity and access
// flows are mounted separately under /api/federation and do not depend on this
// product-specific compatibility surface.
import { provisionRouter } from "./routers/provision.js";
app.route("/api/provision", provisionRouter);

import { federationRouter } from "./routers/federation.js";
app.route("/api/federation", federationRouter);

// Connector sync endpoint (ES256 JWT from CP, pulls records from Nango)
import { connectorsRouter as connectorsRestRouter } from "./routers/connectors.js";
app.route("/api/connectors", connectorsRestRouter);

// Unified inbound webhook surface — all third-party providers under /api/webhooks/*
// Auth is per-provider (HMAC, Bearer token, or static secret — handled inside each router).
// /api/webhooks/messaging  → Unipile (messaging events)
// /api/webhooks/n8n        → N8N inbox ingestion
// /api/webhooks/kratos     → Ory Kratos identity updates
// /api/webhooks/intelligence → IS analysis callbacks
import { n8nWebhookRouter } from "./webhooks/n8n.js";
import { kratosWebhookRouter } from "./webhooks/kratos.js";
import { intelligenceWebhookRouter } from "./webhooks/intelligence.js";
app.route("/api/webhooks", webhooksInboundRouter);
app.route("/api/webhooks/n8n", n8nWebhookRouter);
app.route("/api/webhooks/kratos", kratosWebhookRouter);
app.route("/api/webhooks/intelligence", intelligenceWebhookRouter);

// Pod-to-Pod Sync receive endpoint (Bearer token auth from registered peers)
import { syncReceiveApp } from "@synap/api";
app.route("/api/sync", syncReceiveApp);

// Hub Protocol tRPC bridge — Bearer API-key authenticated tRPC surface used by
// the synap CLI and external agents (procedures: entities, profiles, relations,
// views, sessions, automations, commands, skills, …). Registered BEFORE the
// REST app mount at /api/hub so the /trpc subtree can't be shadowed by it.
// Auth is enforced per-procedure via scopedProcedure (apiKeyMiddleware reads
// the Authorization header from ctx.req).
const hubTrpcBodyMethods = new Set([
  "arrayBuffer",
  "blob",
  "formData",
  "json",
  "text",
] as const);
type HubTrpcBodyMethod = "json" | "text" | "arrayBuffer" | "blob" | "formData";

app.use("/api/hub/trpc/*", async (c) => {
  const req =
    c.req.method === "GET" || c.req.method === "HEAD"
      ? c.req.raw
      : new Proxy(c.req.raw, {
          get(target, prop) {
            if (hubTrpcBodyMethods.has(prop as HubTrpcBodyMethod)) {
              const m = prop as HubTrpcBodyMethod;
              return () => c.req[m]();
            }
            return Reflect.get(target, prop, target);
          },
        });

  const context = await createApiContext(req, c);

  const res = await fetchRequestHandler({
    endpoint: "/api/hub/trpc",
    req,
    router: hubProtocolRouter,
    createContext: async () => context as any,
    onError({ error, path }) {
      apiLogger.error({ err: error, path }, "hub tRPC error");
    },
  });

  return c.newResponse(res.body, res);
});

// Hub Protocol REST adapter (for Intelligence Service; API key auth)
app.route("/api/hub", hubProtocolRestApp);
// Alias: some hub clients use /api/hub-protocol prefix
app.route("/api/hub-protocol", hubProtocolRestApp);

// Integrations capabilities discovery (public, no auth)
app.route("/api/integrations/capabilities", integrationsCapabilitiesApp);

// Channel Gateway REST adapter (for external channel bots; X-Channel-Key auth)
import { channelGatewayApp } from "./routers/channel-gateway.js";
app.route("/api/channels/gateway", channelGatewayApp);

// MCP Server endpoint (for external agents: ZeroClaw, OpenClaw, Claude Desktop, Cursor)
// Auth: Hub Protocol API key via Authorization: Bearer <key>
// Protocol: JSON-RPC 2.0 over HTTP POST
app.route("/mcp", mcpHttpApp);

// External API — Skills invocation (API key auth, scope: skills.invoke)
// GET  /api/external/skills         — list active skills
// POST /api/external/skills/:id/invoke — invoke a skill
app.route("/api/external/skills", externalSkillsApp);

// External API — Conversational chat proxy (API key auth, scope: chat.stream)
// GET  /api/external/chat/channels — list channels user can chat in
// POST /api/external/chat/stream   — proxy to IS chat stream (SSE)
app.route("/api/external/chat", externalChatApp);

// Session-auth chat stream — mirrors /api/external/chat/stream but uses
// the ory session middleware so clients like Relay mobile (which have a
// Kratos session token, not an API key) can stream AI responses over
// plain SSE. The upstream `orySessionMiddleware` is already applied to
// all /api/* paths, so no extra auth wiring is needed here.
// POST /api/chat/stream — session-authed IS chat proxy (SSE)
app.route("/api/chat", chatStreamApp);

// OpenAI-compatible chat completions API (API key auth, scope: chat.stream)
// POST /v1/chat/completions — OpenAI format request/response with SSE streaming
// GET  /v1/models           — list available model aliases
app.route("/v1", openaiCompatApp);

// File Upload REST endpoint (multipart/form-data — not tRPC)
// Auth: Kratos session cookie (applied inside fileUploadApp)
app.route("/api/files", fileUploadApp);

// AI rate limiting for chat/send message path
app.use("/trpc/chat.sendMessage", aiRateLimitMiddleware);
app.use("/trpc/channels.sendMessage", aiRateLimitMiddleware);

// tRPC endpoint
// NOTE: Using fetchRequestHandler directly from @trpc/server instead of
// @hono/trpc-server to avoid version mismatch (hono adapter resolves its own
// @trpc/server@11.8.1, but the app uses @trpc/server@11.16.0).
const bodyMethods = new Set([
  "arrayBuffer",
  "blob",
  "formData",
  "json",
  "text",
] as const);
type BodyMethod = "json" | "text" | "arrayBuffer" | "blob" | "formData";

app.use("/trpc/*", async (c) => {
  const endpoint = "/trpc";

  const req =
    c.req.method === "GET" || c.req.method === "HEAD"
      ? c.req.raw
      : new Proxy(c.req.raw, {
          get(target, prop) {
            if (bodyMethods.has(prop as BodyMethod)) {
              const m = prop as BodyMethod;
              return () => c.req[m]();
            }
            return Reflect.get(target, prop, target);
          },
        });

  const context = await createApiContext(req, c);

  apiLogger.info(
    {
      workspaceId: context.workspaceId,
      userId: context.userId,
      authenticated: context.authenticated,
      hasSession: !!context.session,
      hasUser: !!context.user,
    },
    "tRPC createContext - Using centralized context creation"
  );

  const res = await fetchRequestHandler({
    endpoint,
    req,
    router: appRouter,
    createContext: async () => context as any,
    onError({ error, path }) {
      apiLogger.error({ err: error, path }, "tRPC error");
    },
  });

  return c.newResponse(res.body, res);
});

// pg-boss is initialized in the server startup callback below

// ── First-admin setup page ─────────────────────────────────────────────────
//
// Served at GET /setup. If a ?token= query param is present, shows a form
// to create the first admin account. Without a token, shows an error page.
// The form POSTs to /api/hub/setup/first-admin via fetch (no full-page reload).
app.get("/setup", (c) => {
  const token = c.req.query("token") ?? "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Synap — First Admin Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      width: 100%;
      max-width: 400px;
      padding: 40px 36px;
      background: #111;
      border: 1px solid #222;
      border-radius: 12px;
    }
    .logo {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.5px;
      margin-bottom: 8px;
      color: #fff;
    }
    .subtitle {
      font-size: 13px;
      color: #666;
      margin-bottom: 32px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: #888;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    input {
      width: 100%;
      padding: 10px 14px;
      background: #1a1a1a;
      border: 1px solid #2a2a2a;
      border-radius: 8px;
      color: #e5e5e5;
      font-size: 14px;
      margin-bottom: 18px;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #444; }
    button {
      width: 100%;
      padding: 11px;
      background: #fff;
      color: #000;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.15s;
      margin-top: 4px;
    }
    button:hover { opacity: 0.88; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .error-msg {
      display: none;
      background: #2a1010;
      border: 1px solid #5a2020;
      border-radius: 8px;
      color: #f87171;
      font-size: 13px;
      padding: 10px 14px;
      margin-top: 16px;
    }
    .success-msg {
      display: none;
      background: #0f2a1a;
      border: 1px solid #1a5a2a;
      border-radius: 8px;
      color: #4ade80;
      font-size: 13px;
      padding: 24px 20px;
      margin-top: 8px;
    }
    .err-page { text-align: center; }
    .err-page h2 { font-size: 18px; color: #f87171; margin-bottom: 12px; }
    .err-page p { font-size: 13px; color: #666; line-height: 1.6; }
    code { background: #1a1a1a; border-radius: 4px; padding: 2px 6px; font-size: 12px; color: #aaa; }
  </style>
</head>
<body>
${
  token
    ? `
<div class="card">
  <div class="logo">Synap</div>
  <div class="subtitle">Create your first admin account</div>
  <form id="form">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required placeholder="admin@example.com" />
    <label for="name">Name (optional)</label>
    <input id="name" name="name" type="text" autocomplete="name" placeholder="Your name" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required placeholder="Choose a strong password" />
    <button id="btn" type="submit">Create account</button>
    <div id="err" class="error-msg"></div>
    <div id="ok" class="success-msg"></div>
  </form>
  <script>
    document.getElementById('form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      const ok = document.getElementById('ok');
      err.style.display = 'none';
      ok.style.display = 'none';
      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const res = await fetch('/api/hub/setup/first-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: document.getElementById('email').value.trim(),
            name: document.getElementById('name').value.trim() || undefined,
            password: document.getElementById('password').value,
            magicToken: '${token.replace(/'/g, "\\'")}',
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          err.textContent = data.error || 'Something went wrong.';
          err.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Create account';
        } else {
          document.getElementById('form').style.display = 'none';
          document.querySelector('.subtitle').style.display = 'none';
          ok.innerHTML = \`
            <div style="text-align:center;padding:8px 0 4px">
              <div style="font-size:36px;margin-bottom:12px">✓</div>
              <div style="font-size:15px;font-weight:600;color:#4ade80;margin-bottom:8px">Admin account created</div>
              <div style="font-size:13px;color:#888;line-height:1.6">
                You can close this tab.<br/>
                Your terminal will continue automatically.
              </div>
            </div>
          \`;
          ok.style.display = 'block';
        }
      } catch (ex) {
        err.textContent = 'Network error — please try again.';
        err.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Create account';
      }
    });
  </script>
</div>
`
    : `
<div class="card err-page">
  <div class="logo">Synap</div>
  <h2>Invalid setup link</h2>
  <p>This link is missing a valid token.<br/>Run <code>eve setup admin</code> on your server to generate a new one.</p>
</div>
`
}
</body>
</html>`;

  return c.html(html);
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

// Error handler
app.onError((err, c) => {
  const errorId = crypto.randomUUID();
  // Use existing apiLogger (created at line 50) instead of creating new one

  // HTTPException carries its own status code — let it flow through directly
  // instead of converting it to InternalServerError(500) via toSynapError.
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  // Convert to SynapError if needed (standardized error handling)
  const synapError = isSynapError(err)
    ? err
    : toSynapError(err, "An unexpected error occurred");

  // Only log stack trace for 5xx errors or in development
  const shouldLogStack =
    synapError.statusCode >= 500 || config.server.nodeEnv === "development";

  apiLogger[synapError.statusCode >= 500 ? "error" : "warn"](
    {
      err: synapError,
      errorId,
      path: c.req.path,
      method: c.req.method,
      statusCode: synapError.statusCode,
      ...(shouldLogStack && { stack: synapError.stack }),
    },
    synapError.statusCode >= 500 ? "Server error" : "Client error"
  );

  const isDev = config.server.nodeEnv === "development";

  // Return standardized error response
  // Cast statusCode to satisfy Hono's type requirements
  const statusCode = synapError.statusCode as
    | 400
    | 401
    | 403
    | 404
    | 409
    | 429
    | 500
    | 503;
  return c.json(
    {
      error: synapError.name,
      code: synapError.code,
      message: synapError.message,
      ...(synapError.context && { context: synapError.context }),
      ...(isDev && {
        errorId,
        ...(shouldLogStack && { stack: synapError.stack }),
      }),
    },
    statusCode
  );
});

// Schema coherence tripwire — blocks startup if the live DB is missing any
// critical column the Drizzle schema requires. Runs AFTER migrations have
// been applied (the migration runner is a separate process) and BEFORE the
// HTTP server starts listening, so a drifted pod never serves traffic.
//
// We run this inside an async IIFE so it blocks the rest of bootstrap —
// serve() is only called if the check (and the check alone) resolves.
await (async () => {
  try {
    const { validateSchemaCoherence } = await import("@synap/database");
    await validateSchemaCoherence();
    apiLogger.info("Schema coherence check passed");
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Schema coherence check failed — refusing to start"
    );
    // Print the structured error so ops sees the full list of missing columns
    // in plain text (not JSON-wrapped by the logger).
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exit(1);
  }
})();

// Ontology conversions — the ledger-idempotent DATA-migration runner (the
// conversion manifest SSOT: packages/database/src/conversions/manifest.ts).
//
// Runs AFTER migrations + schema coherence, BEFORE serve() — same startup
// discipline as the schema check above:
//   - Non-destructive ops apply automatically, once. The `_conversions` ledger
//     records applied opKeys, so every subsequent boot skips them (no re-work).
//   - Destructive-tail ops (profile deactivation in mergeInto / dedupe) are
//     DEFERRED, never auto-applied — logged loudly as pending operator action.
//     The operator completes them deliberately with:
//       tsx src/scripts/run-conversions.ts --apply --destructive-tail
//   - A failing op ABORTS startup non-zero (a drifted ontology never serves).
//   - Kill-switch: SYNAP_SKIP_CONVERSIONS=1 skips the whole pass with a warn.
await (async () => {
  if (process.env.SYNAP_SKIP_CONVERSIONS === "1") {
    apiLogger.warn(
      "Ontology conversions SKIPPED (SYNAP_SKIP_CONVERSIONS=1) — the manifest " +
        "will not be applied this boot"
    );
    return;
  }
  try {
    const { sql, runConversions, CONVERSION_MANIFEST } =
      await import("@synap/database");
    const summary = await runConversions(sql, CONVERSION_MANIFEST, {
      dryRun: false,
      destructiveTail: false,
      deferDestructive: true,
    });

    if (summary.hadError) {
      const failed = summary.results.find((r) => r.status === "error");
      throw new Error(
        `Conversion op '${failed?.opKey}' failed: ${failed?.error ?? "unknown error"}`
      );
    }

    const applied = summary.results.filter(
      (r) => r.status === "applied" || r.status === "noop"
    ).length;
    const skipped = summary.results.filter(
      (r) => r.status === "skipped"
    ).length;
    const deferred = summary.results.filter((r) => r.status === "deferred");

    apiLogger.info(
      { applied, skipped, deferred: deferred.length },
      `Ontology conversions: applied ${applied}, skipped ${skipped} (ledger), ` +
        `deferred ${deferred.length} (destructive-tail)`
    );

    if (deferred.length > 0) {
      apiLogger.warn(
        { ops: deferred.map((r) => r.opKey) },
        "Ontology conversions: destructive-tail ops PENDING operator action — " +
          "run `tsx src/scripts/run-conversions.ts --apply --destructive-tail` " +
          "in @synap/database to retire the merged-away / duplicate profiles"
      );
    }
  } catch (err) {
    apiLogger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Ontology conversions failed — refusing to start"
    );
    if (err instanceof Error) {
      console.error(err.message);
    }
    process.exit(1);
  }
})();

// Kratos config coherence tripwire — non-fatal.
//
// Mirrors the schema check above but for `kratos.yml` drift. The most common
// failure mode is: `.env`'s DOMAIN changed (CP-driven `configure-pod.sh`,
// manual edit) but kratos.yml was never regenerated, so the running kratos
// serves a stale `allowed_origins` list. Browsers calling pod-admin then see
// CORS rejections that look like "no Access-Control-Allow-Origin header" —
// hard to diagnose because the network 200/4xx pretends to be a CORS bug.
//
// We probe Kratos directly with a CORS preflight from the expected
// pod-admin origin. If the running kratos echoes the Origin back in
// Access-Control-Allow-Origin, its config is in sync; otherwise we log
// loudly and emit a structured event the dashboard can surface.
//
// NOT fatal — drift here doesn't take down the API, and we don't want a
// transient kratos restart to block backend boot. The operator's fix is:
// `./synap start kratos` (which now regenerates kratos.yml).
void (async () => {
  const domain = process.env.DOMAIN?.trim();
  if (!domain || domain === "localhost") return; // dev mode — skip

  // Synap's domain convention: DOMAIN is `pod.<root>`. Strip the pod prefix
  // to get the bare root, then compute the expected pod-admin origin.
  const bareRoot = domain.startsWith("pod.") ? domain.slice(4) : domain;
  const expectedOrigin = `https://pod-admin.${bareRoot}`;
  const kratosPublicUrl =
    process.env.KRATOS_PUBLIC_URL?.replace(/\/$/, "") || "http://kratos:4433";

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const probeUrl = `${kratosPublicUrl}/self-service/login/api`;
    const res = await fetch(probeUrl, {
      method: "OPTIONS",
      headers: {
        Origin: expectedOrigin,
        "Access-Control-Request-Method": "GET",
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const acao = res.headers.get("access-control-allow-origin") ?? "";
    if (acao !== expectedOrigin && acao !== "*") {
      apiLogger.warn(
        { expectedOrigin, kratosAcao: acao || "<missing>", probeUrl },
        "Kratos CORS coherence check FAILED — pod-admin will see CORS errors. " +
          "Run `./synap start kratos` on the pod host to regenerate kratos.yml."
      );
    } else {
      apiLogger.info({ expectedOrigin }, "Kratos CORS coherence check passed");
    }
  } catch (err) {
    // Don't block boot on a probe failure — kratos may be starting up
    // alongside us and we shouldn't gate the API on it.
    apiLogger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "Kratos CORS coherence probe could not reach kratos (will retry on next boot)"
    );
  }
})();

// WebSocket upgrade router — handles SSH proxy and recipe runner endpoints
import { handleWebSocketUpgrade } from "./ws-router.js";

// Start server
try {
  const httpServer = serve(
    {
      fetch: app.fetch,
      port: config.server.port,
      hostname: "0.0.0.0",
    },
    async (info) => {
      apiLogger.info(
        {
          port: info.port,
          host: "0.0.0.0",
          nodeEnv: config.server.nodeEnv,
        },
        "API server started"
      );

      if (config.server.localMode) {
        // Local mode: pg-boss is disabled (untested on PGlite and would
        // double-fire sync workers alongside the local sync driver).
        // The local sync driver handles all scheduling instead.
        apiLogger.info(
          "Local mode: pg-boss disabled; local sync driver handles scheduling"
        );
        startLocalSyncDriver();
        apiLogger.info("Local sync driver started (LOCAL_MODE)");
      } else {
        // Start pg-boss job queue
        try {
          await startBoss();
          await registerAllWorkers();

          // IoC: fill the import-corpus handler slot owned by @synap/jobs with
          // the orchestrator binding. jobs owns the queue + worker; api (which
          // alone may import the orchestrator) fills the slot here at boot —
          // respecting the one-way api → jobs dependency. analyzeLarge produces
          // a governed import.graph PROPOSAL (never a direct write) and does not
          // read trpcCtx, so the empty ctx below is safe.
          {
            const { registerImportCorpusHandler } =
              await import("@synap/jobs/workers/import-corpus-worker.js");
            const { ImportOrchestrator } = await import("@synap/api");
            registerImportCorpusHandler(async (p) => {
              await new ImportOrchestrator({
                workspaceId: p.workspaceId,
                userId: p.userId,
                trpcCtx: {},
              }).analyzeLarge({
                source: p.source as never,
                items: p.items,
              });
            });
            apiLogger.info("Registered import-corpus handler (IoC)");
          }

          // IoC: fill the capability / signal / feed-runner slots owned by
          // @synap/jobs with the @synap/api implementations. The pg-boss workers
          // run IN this process, but @synap/jobs can't statically import
          // @synap/api (circular dep) — so we inject here at boot. This replaces
          // the former /internal/* HTTP loopback + BRIDGE_SECRET: everything is a
          // direct in-process call now.
          {
            const { registerCapabilityExecutor } =
              await import("@synap/jobs/workers/automation-executor.js");
            const { registerMailFeedRunner } =
              await import("@synap/jobs/workers/mail-feed-cron.js");
            const { registerCalBackfillRunner } =
              await import("@synap/jobs/workers/cal-backfill-cron.js");
            const { registerEventSyncRunner } =
              await import("@synap/jobs/workers/event-sync-cron.js");
            const { registerEventEndRunner } =
              await import("@synap/jobs/workers/event-end-cron.js");
            const { registerSessionRecapRunner } =
              await import("@synap/jobs/workers/session-recap.js");
            const { registerSignalRouter } =
              await import("@synap/jobs/utils/proactive-post.js");
            const api = await import("@synap/api");
            registerCapabilityExecutor((input) => api.executeCapability(input));
            registerMailFeedRunner(() => api.runMailFeed());
            registerCalBackfillRunner(() => api.runCalBackfill());
            registerEventSyncRunner(() => api.runEventSync());
            registerEventEndRunner(() => api.runEventEnd());
            registerSessionRecapRunner((input) => api.runSessionRecap(input));
            registerSignalRouter((input) => api.routeSignal(input));
            apiLogger.info(
              "Registered capability / mail-feed / event-sync / event-end / session-recap / signal handlers (IoC)"
            );
          }

          await registerCronSchedules();
          apiLogger.info(
            "pg-boss job queue started with all workers registered"
          );
        } catch (err) {
          apiLogger.error(
            { err },
            "Failed to start pg-boss (non-fatal, side-effects will be unavailable)"
          );
        }
      }
    }
  );

  // Register WebSocket upgrade router.
  // Routes /api/devplane/ssh to the SSH proxy and /api/devplane/recipe-run to
  // the recipe runner. All other upgrade paths are destroyed to avoid conflicts
  // with Hono SSE or other upgrade handlers.
  httpServer.on("upgrade", handleWebSocketUpgrade);
  apiLogger.info(
    "WebSocket endpoints registered: /api/devplane/ssh, /api/devplane/recipe-run"
  );
} catch (err) {
  apiLogger.error({ err }, "CRITICAL: Failed to start server");
  process.exit(1);
}

// Run startup hooks after server is listening
import { runStartupHooks } from "./startup-hooks.js";
runStartupHooks().catch((err) => {
  apiLogger.error({ err }, "Startup hooks failed (non-fatal)");
});

// Process-level error handlers — catch anything that escapes the request cycle
process.on("unhandledRejection", (reason) => {
  apiLogger.error({ reason }, "Unhandled promise rejection");
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  apiLogger.error({ error }, "Uncaught exception");
  process.exit(1);
});

// Graceful shutdown
["SIGTERM", "SIGINT"].forEach((signal) => {
  process.on(signal, async () => {
    apiLogger.info(`${signal} received, shutting down gracefully`);
    if (config.server.localMode) {
      stopLocalSyncDriver();
    }
    try {
      await stopBoss();
      apiLogger.info("pg-boss stopped");
    } catch (err) {
      apiLogger.error({ err }, "Error stopping pg-boss");
    }
    process.exit(0);
  });
});

export default app;
