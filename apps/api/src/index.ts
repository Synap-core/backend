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

import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { getCookie } from "hono/cookie";
import { trpcServer } from "@hono/trpc-server";
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
  mcpHttpApp,
  fileUploadApp,
  externalSkillsApp,
  externalChatApp,
  chatStreamApp,
  openaiCompatApp,
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
} from "./middleware/security.js";
import { eventStreamManager, setupEventBroadcasting } from "@synap/api";
import { authMiddleware } from "@synap/auth";

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

// CORS middleware — open by design.
//
// The backend is the pod's single security boundary. Auth decisions are
// enforced inside the request:
//   - Ory Kratos session cookies (SameSite=Lax) + Kratos's own CSRF tokens
//     on self-service flows
//   - Bearer tokens (API keys) validated per request
//   - tRPC / REST handlers run their own authorization
//
// An origin whitelist on top of that adds no real security against a
// compromised caller, and creates ongoing drift every time a new first-party
// surface ships (studio, app, landing, relay, …). We reflect whatever origin
// calls us and include credentials, so cookies and sessions Just Work across
// any Synap surface, and let the auth layer decide whether to return data.
//
// Must run first so error responses (429, 413) still carry CORS headers.
// Electron desktop (no Origin header) passes through untouched.
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");
  if (!origin) return next();

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
    const targetUrl = `${kratosPublicUrl}${kratosPath}`;

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

    return new Response(response.body, {
      status: response.status,
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

    const issuerUrl =
      clientIssuerUrl ?? legacyCpUrl ?? config.server.controlPlaneUrl;

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
    // 1. Find existing Kratos identity by email
    // ──────────────────────────────────────────────────────────────────
    let identityId: string | null = null;

    const listResp = await fetch(
      `${kratosAdminUrl}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`
    );

    if (listResp.ok) {
      const identities = (await listResp.json()) as Array<{ id: string }>;
      if (Array.isArray(identities) && identities.length > 0) {
        identityId = identities[0].id;
        apiLogger.info(
          { email, identityId },
          "Handshake: found existing Kratos identity"
        );
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // 2. No identity → behavior depends on pod mode.
    //
    // Dedicated pods:
    //   The admin identity is seeded during provisioning via the pod's
    //   /api/provision/seed-admin endpoint (called by the CP). Handshake
    //   is SSO convenience over an account that MUST already exist.
    //   Returning 403 here indicates the pod wasn't seeded correctly —
    //   the operator needs to re-run seed-admin or the user needs to
    //   recover their password via Kratos self-service.
    //
    // Shared pods:
    //   Users never went through a dedicated provisioning flow — they
    //   interact with the pod exclusively through Relay / landing /
    //   other Synap apps that authenticate via handshake. There's no
    //   user-facing password (they don't need one; recovery via Kratos
    //   self-service still works if they ever want one). So on shared
    //   pods we auto-create the identity with a random password they'll
    //   never know.
    //
    // This split is the minimal path to unblock shared pods without a
    // full setup-flow rework for them. Full design: per-user setup
    // tracking + proper shared-pod onboarding flow. Punted until the
    // shared pod has real traffic.
    // ──────────────────────────────────────────────────────────────────
    if (!identityId) {
      if (!config.server.sharedPodMode) {
        apiLogger.info(
          { email },
          "Handshake rejected: no Kratos identity yet for this email — pod admin must be seeded via /api/provision/seed-admin"
        );
        return c.json(
          {
            error: "account_not_set_up",
            message:
              "This pod has no account for this email yet. Ask your admin to reseed the pod, or use Kratos self-service recovery to set a password.",
            setupRequired: true,
          },
          403
        );
      }

      // Shared pod path — auto-create the identity with a random
      // password. The user doesn't need to know it; handshake will
      // issue sessions via Kratos admin API every time they visit.
      apiLogger.info(
        { email },
        "Handshake (shared pod): auto-creating Kratos identity for new user"
      );
      const placeholderPassword = crypto.randomBytes(32).toString("base64url");
      const createResp = await fetch(`${kratosAdminUrl}/admin/identities`, {
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
            // No setupRequired flag — shared-pod users aren't expected
            // to ever set a password. If they want one they can go
            // through Kratos self-service recovery.
          },
          verifiable_addresses: [
            { value: email, verified: true, via: "email", status: "completed" },
          ],
        }),
      });
      if (!createResp.ok) {
        const errBody = await createResp.text();
        apiLogger.error(
          { status: createResp.status, body: errBody.slice(0, 500) },
          "Failed to create Kratos identity on shared pod"
        );
        return c.json({ error: "Failed to provision user account" }, 500);
      }
      const newIdentity = (await createResp.json()) as { id: string };
      identityId = newIdentity.id;
    }

    // ──────────────────────────────────────────────────────────────────
    // 3. Create a Kratos session via ADMIN API — no password needed.
    //
    // Kratos v1.3+ exposes POST /admin/identities/:id/sessions which
    // returns a session_token we can set as the browser cookie. This
    // replaces the earlier "admin PUT password + self-service login"
    // dance that forced us to know a password.
    // ──────────────────────────────────────────────────────────────────
    const adminSessionResp = await fetch(
      `${kratosAdminUrl}/admin/identities/${identityId}/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }
    );

    if (!adminSessionResp.ok) {
      const errBody = await adminSessionResp.text();
      apiLogger.error(
        {
          status: adminSessionResp.status,
          body: errBody.slice(0, 500),
          identityId,
        },
        "Failed to create Kratos session via admin API"
      );
      return c.json({ error: "Failed to create session" }, 500);
    }

    const adminSessionData = (await adminSessionResp.json()) as {
      session?: { id: string; active?: boolean };
      session_token?: string;
    };

    const sessionToken = adminSessionData.session_token;
    if (!sessionToken) {
      apiLogger.error(
        { identityId },
        "Kratos admin session endpoint returned no session_token"
      );
      return c.json(
        { error: "Session token not returned by auth server" },
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

  // Reflect the caller's origin — CORS is not our security layer (auth is).
  const allowOrigin = c.req.header("origin") || "*";

  // Return SSE stream using Hono's newResponse
  // c.newResponse(body, status, headers) signature
  return c.newResponse(stream, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Credentials": "true",
  });
});

// tRPC routes — apply session auth for all routes except health.* and setup.*
// system.* procedures enforce their own auth level (protectedProcedure / podAdminProcedure)
app.use("/trpc/*", async (c, next) => {
  const path = c.req.path;

  // health.* and setup.* are always public (no session required)
  if (path.includes("health.") || path.includes("setup.")) {
    return next();
  }

  // Everything else requires a valid Kratos session
  return authMiddleware(c, next);
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

// Webhook routes (before auth - uses webhook secret auth)
import { webhookRouter } from "./webhooks/index.js";
app.route("/webhooks", webhookRouter);

// Pod-to-Pod Sync receive endpoint (Bearer token auth from registered peers)
import { syncReceiveApp } from "@synap/api";
app.route("/api/sync", syncReceiveApp);

// Hub Protocol REST adapter (for Intelligence Service; API key auth)
app.route("/api/hub", hubProtocolRestApp);
// Alias: some hub clients use /api/hub-protocol prefix
app.route("/api/hub-protocol", hubProtocolRestApp);

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
app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    // @hono/trpc-server passes Hono Context as second argument
    // opts may also contain the context in some versions
    createContext: async (
      opts: { req?: Request; c?: HonoContext },
      c?: HonoContext
    ) => {
      // Get Hono context (already has validated session from orySessionMiddleware)
      const honoCtx: HonoContext | undefined = opts.c || c;

      if (!honoCtx) {
        apiLogger.error("Hono context not available in tRPC createContext");
        throw new Error("Hono context not available");
      }

      // Extract Request object from Hono context
      const req = honoCtx.req.raw || honoCtx.req;

      // Use centralized createContext from @synap/api
      // Pass Hono context so it can use pre-validated session (no duplication)
      const context = await createApiContext(req, honoCtx);

      // Log workspace ID extraction for debugging
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

      // @hono/trpc-server requires Record<string, unknown>, but our Context is more specific
      // This assertion is safe because Context only contains serializable values
      // and is compatible with Record<string, unknown> at runtime
      return context as unknown as Record<string, unknown>;
    },
    onError({ error, path }) {
      apiLogger.error({ err: error, path }, "tRPC error");
    },
  })
);

// pg-boss is initialized in the server startup callback below

// Admin UI — static SPA (served from /admin/)
import { serveStatic } from "@hono/node-server/serve-static";
import path from "path";
import fs from "fs";

// Redirect /admin to /admin/
app.get("/admin", (c) => c.redirect("/admin/"));

// Serve static files from the admin-ui build
app.use(
  "/admin/*",
  serveStatic({
    root: "./admin-ui/",
    rewriteRequestPath: (p: string) => p.replace("/admin/", "/"),
    onNotFound: () => {
      // Let it fall through to the SPA fallback below
    },
  })
);

// SPA fallback — any /admin/* path that didn't match a static file returns index.html
app.get("/admin/*", (c) => {
  try {
    const indexPath = path.resolve("./admin-ui/index.html");
    const html = fs.readFileSync(indexPath, "utf-8");
    return c.html(html);
  } catch {
    return c.json({ error: "Admin UI not built" }, 404);
  }
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

// Error handler
app.onError((err, c) => {
  const errorId = crypto.randomUUID();
  // Use existing apiLogger (created at line 50) instead of creating new one

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

// Start server
try {
  serve(
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
