/**
 * Synap API Server
 *
 * Hono server with:
 * - tRPC API endpoints
 * - Ory Kratos routes (session-based authentication)
 * - Token Exchange endpoint
 * - Control Plane Handshake endpoint (/api/handshake)
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
} from "@synap/jobs";
import crypto from "crypto";
import { verifyCpJwtWithTrust } from "@synap/api";
import {
  rateLimitMiddleware,
  aiRateLimitMiddleware,
  requestSizeLimit,
  handshakeRateLimitMiddleware,
} from "./middleware/security.js";
import { eventStreamManager, setupEventBroadcasting } from "@synap/api";
import { authMiddleware } from "@synap/auth";
import { buildKratosProxyTargetUrl } from "./kratos-proxy-url.js";

// Setup event broadcasting to SSE clients
const apiLogger = createLogger({ module: "api-server" });
setupEventBroadcasting();
apiLogger.info("Event broadcasting initialized");

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

  // Validate Ory Stack (Kratos + Hydra) auth config
  validateConfig("ory");
  apiLogger.info("Ory Stack configuration validated");
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

// Initialize Hono app
const app = new Hono();

// CORS middleware — derived first-party allowlist (Pattern B), credentialed.
//
// Reflecting every origin together with Allow-Credentials is the textbook
// CSWSH/credentialed-CORS vulnerability (an attacker page can read any
// cookie-authed response cross-origin). Instead we echo the Origin back ONLY
// when it is a trusted first party — the base domain or any of its subdomains
// (SYNAP_BASE_DOMAIN), the explicit ALLOWED_ORIGINS list, or the pod's own
// PUBLIC_URL. See cors-origin.ts. Cookies/sessions still Just Work across every
// first-party Synap surface; unknown origins get no ACAO header and the browser
// blocks the cross-origin read (fail closed).
//
// Must run first so error responses (429, 413) still carry CORS headers.
// Electron desktop (no Origin header) passes through untouched.
import { isAllowedOrigin, hasConfiguredOrigins } from "./cors-origin.js";

if (!hasConfiguredOrigins() && process.env.NODE_ENV === "production") {
  apiLogger.warn(
    "[SECURITY] Neither SYNAP_BASE_DOMAIN nor ALLOWED_ORIGINS is set — all cross-origin browser requests will be denied. Set SYNAP_BASE_DOMAIN to your pod's base domain (e.g. example.com) so first-party surfaces (studio., app., …) can reach the pod."
  );
}

app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && isAllowedOrigin(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
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
  const kratosPath = c.req.path.replace("/.ory/kratos/public", "");
  return proxyKratosRequest(c, kratosPath);
});

// Legacy route: /self-service/* (for backward compatibility)
app.all("/self-service/*", async (c) => {
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

// Control Plane Handshake Endpoint
// Accepts a short-lived ES256 JWT issued by the Synap Control Plane.
// Verifies via /.well-known/jwks.json (no shared secret required),
// then creates or finds a Kratos identity and issues a Kratos session.
// The session cookie is set in the response for browser-based auth.
//
// Flow:
//   Browser → POST /pods/handshake (control plane) → ES256 JWT
//   Browser → POST ${podUrl}/api/handshake { token } (this endpoint) → Kratos session cookie
app.use("/api/handshake", handshakeRateLimitMiddleware);
app.post("/api/handshake", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const {
      token,
      issuerUrl: clientIssuerUrl,
      cpUrl: legacyCpUrl,
    } = body as { token?: string; issuerUrl?: string; cpUrl?: string };

    if (!token || typeof token !== "string") {
      return c.json({ error: "token is required" }, 400);
    }

    // Verify the handshake JWT via the issuer's JWKS (ES256) AND enforce the
    // trusted_issuers allowlist. The audience claim (PUBLIC_URL) is mandatory —
    // skipping it would let a token minted for another pod be replayed here.
    //
    // Issuer URL resolution:
    //   - Client-provided issuerUrl or legacy cpUrl → passed as explicit allowlist
    //   - CONTROL_PLANE_URL env var → passed as explicit allowlist
    //   - Neither set → verifyCpJwt reads the `iss` claim from the JWT itself,
    //     but trusted_issuers lookup still gates acceptance.
    const podPublicUrl = process.env.PUBLIC_URL;
    if (!podPublicUrl) {
      apiLogger.error(
        "Handshake refused: PUBLIC_URL not configured — audience check is mandatory"
      );
      return c.json(
        { error: "PUBLIC_URL not configured; handshake refused" },
        500
      );
    }

    // issuerUrl resolution: client always passes issuerUrl; legacyCpUrl is for old clients.
    // No env-var fallback — if neither is provided, verifyCpJwt reads the token's own `iss`
    // claim and the trusted_issuers registry gates acceptance.
    const issuerUrl = clientIssuerUrl ?? legacyCpUrl;

    const payload = await verifyCpJwtWithTrust<{
      sub: string;
      email: string;
      name?: string;
      aud: string;
      type: string;
      trialEnd?: string;
    }>(token, { pinnedIssuer: issuerUrl, audience: podPublicUrl });

    if (!payload) {
      apiLogger.warn(
        { issuerUrl, podPublicUrl },
        "Handshake token verification failed — signature/audience/expiry or trusted-issuer check failed"
      );
      return c.json(
        {
          error: "Invalid or expired handshake token",
          code: "JWT_VERIFICATION_FAILED",
          hint: `Token audience must match this pod's PUBLIC_URL (${podPublicUrl}) and issuer must be approved in trusted_issuers`,
        },
        401
      );
    }

    if (payload.type !== "handshake") {
      return c.json({ error: "Invalid token type" }, 400);
    }

    // Normalize email so lookups survive casing differences between the
    // CP's Better Auth user record, the seed-admin-normalized email, and
    // whatever casing the user originally typed. Without this, a JWT
    // carrying "Alice@Ex.com" wouldn't find the Kratos identity created
    // by seed-admin as "alice@ex.com" — and handshake would happily
    // create a second identity, so the user ends up with two accounts:
    // one they can sign into (from seeding), one the handshake keeps
    // spawning (with a throwaway password).
    // `name` used to be read here for the auto-create path; now that
    // handshake only looks up existing identities (seed-admin owns
    // creation), the claim is informational and we don't need it.
    const rawEmail = payload.email;
    const email = rawEmail?.trim().toLowerCase();
    if (!email) {
      return c.json({ error: "Token missing email claim" }, 400);
    }

    const kratosAdminUrl =
      process.env.KRATOS_ADMIN_URL || "http://localhost:4434";

    // ──────────────────────────────────────────────────────────────────
    // 1. Find existing Kratos identity by email.
    //
    // Kratos is the source of truth for auth identities. The CP seeds
    // the identity via /api/provision/seed-admin during provisioning
    // (dedicated pods) or we auto-create it here (shared pods).
    //
    // NOTE: user changing their Kratos password never breaks handshake —
    // step 3 uses the admin API which bypasses password entirely.
    // ──────────────────────────────────────────────────────────────────
    let identityId: string | null = null;
    let kratosUnreachable = false;

    try {
      const listResp = await fetch(
        `${kratosAdminUrl}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`,
        { signal: AbortSignal.timeout(8_000) }
      );

      if (listResp.ok) {
        const identities = (await listResp.json()) as Array<{ id: string }>;
        if (Array.isArray(identities) && identities.length > 0) {
          identityId = identities[0].id;
          apiLogger.info(
            { email, identityId },
            "Handshake: found Kratos identity"
          );
        }
      } else {
        const errBody = await listResp.text().catch(() => "");
        apiLogger.error(
          {
            status: listResp.status,
            body: errBody.slice(0, 500),
            kratosAdminUrl,
          },
          "Handshake: Kratos identity lookup returned non-OK"
        );
        // Non-OK from Kratos admin API = Kratos is up but broken.
        // Fall through — identityId stays null → handled below.
      }
    } catch (err) {
      kratosUnreachable = true;
      apiLogger.error(
        { err, kratosAdminUrl },
        "Handshake: Kratos admin API unreachable"
      );
    }

    if (kratosUnreachable) {
      return c.json(
        {
          error: "auth_service_unavailable",
          code: "KRATOS_UNREACHABLE",
          message:
            "The pod's auth service is not reachable. The pod may still be starting up.",
        },
        503
      );
    }

    // ──────────────────────────────────────────────────────────────────
    // 2. No identity → behavior depends on pod mode.
    //
    // Dedicated pods:
    //   Identity MUST already exist — seeded by /api/provision/seed-admin
    //   during provisioning. Missing identity = provisioning incomplete.
    //   Return 403 so the client shows "reseed required" rather than 500.
    //
    // Shared pods:
    //   No provisioning flow. Auto-create on first handshake.
    // ──────────────────────────────────────────────────────────────────
    if (!identityId) {
      if (!config.server.sharedPodMode) {
        apiLogger.warn(
          { email },
          "Handshake: no Kratos identity for email on dedicated pod — provisioning incomplete (seed-admin must be re-run)"
        );
        return c.json(
          {
            error: "account_not_set_up",
            code: "IDENTITY_NOT_FOUND",
            message:
              "No account exists for this email on this pod. The pod may need to be re-provisioned (reseed-admin from the control plane dashboard).",
            setupRequired: true,
          },
          403
        );
      }

      // Shared pod path — auto-create identity. Handshake always uses the
      // admin API to create sessions, so the password is never needed.
      apiLogger.info(
        { email },
        "Handshake (shared pod): auto-creating Kratos identity"
      );
      const placeholderPassword = crypto.randomBytes(32).toString("base64url");
      let createResp: Response;
      try {
        createResp = await fetch(`${kratosAdminUrl}/admin/identities`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            schema_id: "default",
            traits: { email },
            credentials: {
              password: { config: { password: placeholderPassword } },
            },
            metadata_public: {
              createdVia: "handshake-shared",
              createdAt: new Date().toISOString(),
            },
            verifiable_addresses: [
              {
                value: email,
                verified: true,
                via: "email",
                status: "completed",
              },
            ],
          }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch (err) {
        apiLogger.error(
          { err },
          "Handshake: Kratos identity create threw (network)"
        );
        return c.json(
          { error: "auth_service_unavailable", code: "KRATOS_UNREACHABLE" },
          503
        );
      }
      if (!createResp.ok) {
        const errBody = await createResp.text();
        apiLogger.error(
          { status: createResp.status, body: errBody.slice(0, 500) },
          "Handshake: failed to create Kratos identity on shared pod"
        );
        return c.json(
          {
            error: "Failed to provision user account",
            code: "KRATOS_CREATE_FAILED",
            detail: errBody.slice(0, 200),
          },
          500
        );
      }
      const newIdentity = (await createResp.json()) as { id: string };
      identityId = newIdentity.id;
    }

    // The handshake contract, used by both CP pre-provisioning and desktop
    // connect, is stronger than "return a Kratos session": after a successful
    // exchange the pod user must also have a Synap DB user row and at least one
    // workspace membership. Otherwise the Browser authenticates successfully
    // but `workspaces.list` returns [] forever. `seedAdminUser` is idempotent:
    // it upserts the user and reuses an existing membership, or creates the
    // default personal workspace when none exists.
    try {
      const { seedAdminUser } = await import("@synap/database");
      const seedResult = await seedAdminUser({
        kratosIdentityId: identityId,
        email,
        name: payload.name,
        emailVerified: true,
      });
      apiLogger.info(
        {
          email,
          identityId,
          workspaceId: seedResult.workspaceId,
          alreadyExisted: seedResult.alreadyExisted,
        },
        "Handshake ensured DB user and workspace membership"
      );
    } catch (err) {
      apiLogger.error(
        { err, email, identityId },
        "Handshake failed to ensure DB user/workspace membership"
      );
      return c.json(
        {
          error: "Failed to provision pod workspace",
          code: "DB_WORKSPACE_SEED_FAILED",
        },
        500
      );
    }

    // ──────────────────────────────────────────────────────────────────
    // 3. Create a Kratos session via ADMIN API — no password needed.
    //
    // POST /admin/identities/:id/sessions (Kratos v1.3+) creates a
    // privileged session and returns session_token. This token is
    // what the browser sends as the ory_kratos_session cookie.
    //
    // Note: password changes on the pod never break this — the admin
    // API bypasses the credential check entirely.
    // ──────────────────────────────────────────────────────────────────
    let adminSessionResp: Response;
    try {
      adminSessionResp = await fetch(
        `${kratosAdminUrl}/admin/identities/${identityId}/sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(8_000),
        }
      );
    } catch (err) {
      apiLogger.error(
        { err, identityId },
        "Handshake: Kratos session create threw (network)"
      );
      return c.json(
        { error: "auth_service_unavailable", code: "KRATOS_UNREACHABLE" },
        503
      );
    }

    if (!adminSessionResp.ok) {
      const errBody = await adminSessionResp.text().catch(() => "");
      apiLogger.error(
        {
          status: adminSessionResp.status,
          body: errBody.slice(0, 500),
          identityId,
        },
        "Handshake: Kratos session creation failed"
      );
      return c.json(
        {
          error: "Failed to create session",
          code: "KRATOS_SESSION_FAILED",
          kratosStatus: adminSessionResp.status,
          // Include Kratos error detail so the dashboard/client can diagnose without SSH.
          detail: errBody.slice(0, 300),
        },
        500
      );
    }

    const adminSessionData = (await adminSessionResp.json()) as {
      session?: { id: string; active?: boolean };
      session_token?: string;
    };

    const sessionToken = adminSessionData.session_token;
    if (!sessionToken) {
      apiLogger.error(
        { identityId },
        "Handshake: Kratos returned 200 but no session_token — check Kratos tokenizer config"
      );
      return c.json(
        {
          error: "Session token not returned by auth server",
          code: "KRATOS_NO_SESSION_TOKEN",
          hint: "Kratos may be running a version < 1.0 or session tokenizer is not configured",
        },
        500
      );
    }

    // Shape the rest of the handler to match the previous success path:
    // treat `sessionData` as if it came from the native login flow.
    const sessionData: {
      session?: { id: string; active?: boolean };
      session_token?: string;
    } = adminSessionData;

    // ──────────────────────────────────────────────────────────────────
    // 4. Set session cookie for the browser.
    //
    // `c.req.url` alone is unreliable here: Caddy terminates TLS and forwards
    // to backend:4000 over plain HTTP, so `c.req.url.startsWith("https")` is
    // always false behind the reverse proxy — which would drop the `Secure`
    // flag. Modern browsers reject `SameSite=None` cookies without `Secure`,
    // so the cookie would silently never reach the client.
    //
    // Detect HTTPS via the proxy's forwarded proto header, with X-Forwarded-Proto
    // and X-Scheme as fallbacks, and finally trust PUBLIC_URL as the ground truth
    // for the public origin. Default to Secure=true in production to fail safe.
    const forwardedProto = c.req
      .header("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim();
    const isSecure =
      forwardedProto === "https" ||
      c.req.header("x-scheme") === "https" ||
      c.req.url.startsWith("https") ||
      (process.env.PUBLIC_URL ?? "").startsWith("https://") ||
      process.env.NODE_ENV === "production";

    c.header(
      "Set-Cookie",
      `ory_kratos_session=${sessionToken}; Path=/; HttpOnly; ${isSecure ? "Secure; " : ""}SameSite=None`
    );

    apiLogger.info(
      { email, identityId },
      "Handshake successful — session created"
    );

    // 5. Store trialEnd from JWT payload in workspace settings (shared pod only)
    if (payload.trialEnd && config.server.sharedPodMode && identityId) {
      try {
        const { getDb, eq } = await import("@synap/database");
        const { workspaceMembers, workspaces } =
          await import("@synap/database/schema");
        const handshakeDb = await getDb();

        // Find the user's workspace membership
        const membership = await handshakeDb.query.workspaceMembers.findFirst({
          where: eq(workspaceMembers.userId, identityId),
          columns: { workspaceId: true },
        });

        if (membership) {
          const ws = await handshakeDb.query.workspaces.findFirst({
            where: eq(workspaces.id, membership.workspaceId),
            columns: { settings: true },
          });

          const existing = (ws?.settings as Record<string, unknown>) ?? {};
          const existingCp =
            (existing.controlPlane as Record<string, unknown>) ?? {};

          await handshakeDb
            .update(workspaces)
            .set({
              settings: drizzleSql`settings || ${JSON.stringify({
                controlPlane: { ...existingCp, trialEnd: payload.trialEnd },
              })}::jsonb`,
              updatedAt: new Date(),
            })
            .where(eq(workspaces.id, membership.workspaceId));

          apiLogger.info(
            { identityId, trialEnd: payload.trialEnd },
            "Stored trialEnd in workspace settings"
          );
        }
      } catch (trialErr) {
        // Non-fatal — don't break handshake if trial storage fails
        apiLogger.warn(
          { err: trialErr },
          "Failed to store trialEnd in workspace settings"
        );
      }
    }

    return c.json({
      success: true,
      session: sessionData.session,
      session_token: sessionToken,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "Handshake endpoint error");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Session check endpoint — used by the web landing page (synap.dev) to determine
// if the user already has a valid pod session after a previous handshake, so it
// doesn't need to re-run the handshake on every page load.
//
// Auth: ory_kratos_session cookie (set by /api/handshake). Public endpoint.
// Returns 200 + session data if valid, 401 if missing or expired.
app.get("/api/session", async (c) => {
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

apiLogger.info(
  "Ory Kratos routes enabled at /.ory/kratos/public/* and /self-service/*"
);
apiLogger.info("Token Exchange endpoint enabled at /api/auth/token-exchange");
apiLogger.info("Control Plane handshake endpoint enabled at /api/handshake");

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

// Admin routes (public API for invitations)
import { adminRouter } from "./routers/admin.js";
app.route("/api/admin", adminRouter);

// Admin source configs (CP-provisioned feed source configurations — ES256 JWT auth)
import { adminSourceConfigsRouter } from "@synap/api";
app.route("/api/admin/source-configs", adminSourceConfigsRouter);

// Control Plane provisioning endpoint (ES256 JWT, verified via JWKS)
import { provisionRouter } from "./routers/provision.js";
app.route("/api/provision", provisionRouter);

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

// Hub Protocol REST adapter (for Intelligence Service; API key auth)
app.route("/api/hub", hubProtocolRestApp);
// Alias: some hub clients use /api/hub-protocol prefix
app.route("/api/hub-protocol", hubProtocolRestApp);

// Integrations capabilities discovery (public, no auth)
app.route("/api/integrations/capabilities", integrationsCapabilitiesApp);

// Channel Gateway REST adapter (for external channel bots; X-Channel-Key auth)
import { channelGatewayApp } from "./routers/channel-gateway.js";
import { sql as drizzleSql } from "drizzle-orm";
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

      // Start pg-boss job queue
      try {
        await startBoss();
        await registerAllWorkers();
        await registerCronSchedules();
        apiLogger.info("pg-boss job queue started with all workers registered");
      } catch (err) {
        apiLogger.error(
          { err },
          "Failed to start pg-boss (non-fatal, side-effects will be unavailable)"
        );
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
