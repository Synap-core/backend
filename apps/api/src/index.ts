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
} from "@synap/api";
import { serve } from "@hono/node-server";
import {
  startBoss,
  stopBoss,
  registerAllWorkers,
  registerCronSchedules,
} from "@synap/jobs";
import crypto from "crypto";
import { verifyCpJwt } from "@synap/api";
import {
  getCorsOrigins,
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

    // Validate CORS origins — without this the API silently rejects all browser requests
    if (!process.env.ALLOWED_ORIGINS) {
      throw new Error(
        "ALLOWED_ORIGINS is not set in production. " +
          "Set it to a comma-separated list of allowed frontend origins " +
          "(e.g. ALLOWED_ORIGINS=https://app.synap.live). " +
          "Without this all browser requests will be rejected by CORS."
      );
    }
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

// Smart CORS middleware — must be first so even error responses (429, 413) carry CORS headers.
//
// Two security modes, selected per-request:
//
//  1. API-key mode (Bearer token present, or preflight requesting Authorization header):
//     → Allow any origin. No credentials header.
//     → Rationale: Bearer tokens are explicit — the browser never sends them automatically.
//       CORS cannot protect against a stolen API key (the attacker can call from their server
//       anyway). Requiring the caller to whitelist their domain adds friction with zero security.
//
//  2. Cookie mode (Ory Kratos session, no Bearer token):
//     → Enforce the CORS origin whitelist (env + DB-stored origins).
//     → Include Access-Control-Allow-Credentials: true.
//     → Rationale: Session cookies ARE sent automatically. Without a whitelist, any page could
//       make authenticated requests using the user's Kratos session (CSRF via CORS).
//
// Electron desktop (no Origin header at all) passes through untouched.
app.use("*", async (c, next) => {
  const origin = c.req.header("origin");

  // No Origin header: Electron, server-to-server, or same-origin — no CORS needed.
  if (!origin) return next();

  // Detect API-key mode:
  //  - Actual request: Authorization: Bearer xxx header
  //  - Preflight (OPTIONS): browser signals it will send Authorization via
  //    Access-Control-Request-Headers
  const authHeader = c.req.header("authorization") ?? "";
  const requestedHeaders = c.req.header("access-control-request-headers") ?? "";
  const isApiKeyMode =
    authHeader.startsWith("Bearer ") ||
    requestedHeaders
      .toLowerCase()
      .split(",")
      .some((h) => h.trim() === "authorization");

  const ALLOW_METHODS = "GET, POST, PUT, DELETE, PATCH, OPTIONS";
  const ALLOW_HEADERS = "Content-Type, Authorization, Cookie, X-Workspace-Id";
  const EXPOSE_HEADERS = "Content-Length, X-Request-Id, Set-Cookie";

  if (isApiKeyMode) {
    // Allow any origin — Bearer token auth is safe cross-origin
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Methods", ALLOW_METHODS);
    c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
    c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    c.header("Access-Control-Max-Age", "86400");
  } else {
    // Cookie auth: only whitelisted origins can send session cookies cross-origin
    const allowed = getCorsOrigins();
    if (allowed.includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Methods", ALLOW_METHODS);
      c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
      c.header("Access-Control-Expose-Headers", EXPOSE_HEADERS);
      c.header("Access-Control-Max-Age", "86400");
    }
    // Origin not in whitelist → no CORS headers → browser blocks the request ✓
  }

  // Answer preflights immediately
  if (c.req.method === "OPTIONS") return c.body(null, 204);

  return next();
});

// Security Middleware
app.use("*", requestSizeLimit); // Max 10MB requests
app.use("*", rateLimitMiddleware); // 500 req/15min per IP
app.use("*", secureHeaders()); // Hono built-in security headers
apiLogger.info("Security middleware registered");

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

    // Get all response headers as plain object
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Return Response using Hono's newResponse for proper type compatibility
    // c.newResponse(body, status, headers) signature
    return c.newResponse(
      response.body,
      response.status as any,
      responseHeaders
    );
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

    // Verify the handshake JWT via the issuer's JWKS (ES256).
    // The pod is self-hostable and may not know which service signed the token.
    //
    // Issuer URL resolution (in priority order):
    //   1. Client-provided issuerUrl (the client just called the issuer, so it knows)
    //   2. Legacy "cpUrl" field (backward-compat with older clients)
    //   3. Pod env var CONTROL_PLANE_URL (operator-configured)
    //   4. workspace.settings.controlPlane.url (set during provisioning)
    //
    // Security: the JWT is verified using JWKS fetched from the issuer URL.
    // Even if the client provides a malicious URL, verification fails because
    // the JWT was signed with a different key. The audience check (PUBLIC_URL)
    // further prevents cross-pod token reuse.
    let issuerUrl =
      clientIssuerUrl ?? legacyCpUrl ?? config.server.controlPlaneUrl;
    if (!issuerUrl) {
      try {
        const { getDb } = await import("@synap/database");
        const db = await getDb();
        const ws = await db.query.workspaces.findFirst();
        const settings = (ws?.settings as any)?.controlPlane;
        if (settings?.url) {
          issuerUrl = settings.url;
          apiLogger.info(
            { issuerUrl },
            "Handshake: resolved issuer URL from workspace settings"
          );
        }
      } catch {}
    }

    if (!issuerUrl) {
      apiLogger.warn(
        "Handshake: no issuer URL available — cannot verify token"
      );
      return c.json(
        {
          error:
            "Cannot verify handshake token: no issuer URL available. " +
            "Pass issuerUrl in the request body, or set CONTROL_PLANE_URL on the pod.",
          code: "NO_ISSUER_URL",
        },
        503
      );
    }

    const podPublicUrl = process.env.PUBLIC_URL;
    const payload = await verifyCpJwt<{
      sub: string;
      email: string;
      name?: string;
      aud: string;
      type: string;
      trialEnd?: string;
    }>(token, issuerUrl, podPublicUrl);

    if (!payload) {
      apiLogger.warn(
        { issuerUrl, podPublicUrl },
        "Handshake token verification failed — JWT signature/audience/expiry check failed"
      );
      return c.json(
        {
          error: "Invalid or expired handshake token",
          code: "JWT_VERIFICATION_FAILED",
          hint: podPublicUrl
            ? `Token audience must match this pod's PUBLIC_URL (${podPublicUrl})`
            : "This pod has no PUBLIC_URL set — audience check is skipped but signature verification may have failed",
        },
        401
      );
    }

    if (payload.type !== "handshake") {
      return c.json({ error: "Invalid token type" }, 400);
    }

    const { email, name } = payload;
    if (!email) {
      return c.json({ error: "Token missing email claim" }, 400);
    }

    const kratosAdminUrl =
      process.env.KRATOS_ADMIN_URL || "http://localhost:4434";

    // 1. Find existing Kratos identity by email
    let identityId: string | null = null;

    const listResp = await fetch(
      `${kratosAdminUrl}/admin/identities?credentials_identifier=${encodeURIComponent(email)}`
    );

    if (listResp.ok) {
      const identities = (await listResp.json()) as Array<{ id: string }>;
      if (Array.isArray(identities) && identities.length > 0) {
        identityId = identities[0].id;
        apiLogger.info({ email, identityId }, "Found existing Kratos identity");
      }
    }

    // 2. If no identity, create one (provisioning new cloud user on this pod)
    if (!identityId) {
      apiLogger.info({ email }, "Creating new Kratos identity for cloud user");

      const createResp = await fetch(`${kratosAdminUrl}/admin/identities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          schema_id: "default",
          traits: { email, ...(name ? { name } : {}) },
          credentials: {
            password: {
              config: {
                // Random password — this user authenticates via handshake, not password
                password: crypto.randomBytes(32).toString("hex"),
              },
            },
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
      });

      if (!createResp.ok) {
        const errBody = await createResp.text();
        apiLogger.error(
          { status: createResp.status, body: errBody },
          "Failed to create Kratos identity"
        );
        return c.json({ error: "Failed to provision user account" }, 500);
      }

      const newIdentity = (await createResp.json()) as { id: string };
      identityId = newIdentity.id;
      apiLogger.info({ email, identityId }, "Created Kratos identity");
    }

    // 3. Create a Kratos session for the identity via admin API
    const sessionResp = await fetch(
      `${kratosAdminUrl}/admin/identities/${identityId}/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }
    );

    if (!sessionResp.ok) {
      const errBody = await sessionResp.text();
      apiLogger.error(
        { status: sessionResp.status, body: errBody },
        "Failed to create Kratos session"
      );
      return c.json({ error: "Failed to create session" }, 500);
    }

    const sessionData = (await sessionResp.json()) as {
      session?: { id: string; active: boolean };
      session_token?: string;
    };

    const sessionToken = sessionData.session_token;

    if (!sessionToken) {
      apiLogger.error({ sessionData }, "No session_token in Kratos response");
      return c.json(
        { error: "Session token not returned by auth server" },
        500
      );
    }

    // 4. Set session cookie for the browser
    const isSecure = c.req.url.startsWith("https");
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

// ---------------------------------------------------------------------------
// Telegram Mini App Auth Endpoint
// Accepts raw Telegram initData, validates HMAC using this pod's
// TELEGRAM_BOT_TOKEN, looks up channel_connections, creates Kratos session.
//
// No shared secret needed — the pod validates everything itself.
// The Mini App (Vercel) is a zero-secret proxy.
//
// Auth: Telegram initData HMAC-SHA256 (validated server-side using bot token).
//
// Flow:
//   Mini App → POST ${podUrl}/api/auth/telegram { initData } →
//   Pod validates HMAC → channel_connections lookup → Kratos session
// ---------------------------------------------------------------------------
app.post("/api/auth/telegram", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { initData } = body as { initData?: string };

    if (!initData || typeof initData !== "string") {
      return c.json({ error: "initData is required" }, 400);
    }

    // 0. Validate Telegram initData HMAC
    const { resolveTelegramBotToken } = await import("@synap/api");
    const botToken = await resolveTelegramBotToken();
    if (!botToken) {
      apiLogger.error(
        "Telegram bot token not found in vault, workspace settings, or env"
      );
      return c.json({ error: "Telegram not configured on this pod" }, 503);
    }

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) {
      return c.json({ error: "Missing hash in initData" }, 401);
    }

    // Remove hash from params, sort, build check string
    params.delete("hash");
    const entries = Array.from(params.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    // HMAC-SHA256 validation
    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (computedHash !== hash) {
      return c.json({ error: "Invalid initData signature" }, 401);
    }

    // Check auth_date freshness (24 hours)
    const authDate = parseInt(params.get("auth_date") ?? "0", 10);
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) {
      return c.json({ error: "initData expired" }, 401);
    }

    // Extract Telegram user
    const userRaw = params.get("user");
    if (!userRaw) {
      return c.json({ error: "Missing user in initData" }, 401);
    }

    let telegramUser: { id: number; username?: string; first_name?: string };
    try {
      telegramUser = JSON.parse(userRaw);
    } catch {
      return c.json({ error: "Invalid user JSON in initData" }, 401);
    }

    const telegramUserId = String(telegramUser.id);

    // 1. Look up channel connection
    const { db, eq, and } = await import("@synap/database");
    const { channelConnections } = await import("@synap/database/schema");
    const { ensurePersonalChannel } = await import("@synap/api");

    const connection = await db.query.channelConnections.findFirst({
      where: and(
        eq(channelConnections.channel, "telegram"),
        eq(channelConnections.channelUserId, telegramUserId)
      ),
    });

    if (!connection) {
      return c.json(
        { error: "not_linked", message: "Telegram account not linked" },
        404
      );
    }

    const { userId, workspaceId } = connection;

    // 2. Find Kratos identity for this user
    const kratosAdminUrl =
      process.env.KRATOS_ADMIN_URL || "http://localhost:4434";

    // The userId in channel_connections IS the Kratos identity ID
    // (set during the /link flow from the authenticated Synap user)
    const identityId = userId;

    // 3. Create a Kratos session for the identity
    const sessionResp = await fetch(
      `${kratosAdminUrl}/admin/identities/${identityId}/sessions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }
    );

    if (!sessionResp.ok) {
      const errBody = await sessionResp.text();
      apiLogger.error(
        { status: sessionResp.status, body: errBody, userId },
        "Failed to create Kratos session for Telegram user"
      );
      return c.json({ error: "Failed to create session" }, 500);
    }

    const sessionData = (await sessionResp.json()) as {
      session?: { id: string };
      session_token?: string;
    };

    const sessionToken = sessionData.session_token;
    if (!sessionToken) {
      return c.json({ error: "No session token returned" }, 500);
    }

    // 4. Ensure the user has a dedicated Telegram channel
    let telegramChannelId = connection.defaultChannelId;
    if (!telegramChannelId) {
      const personalChannel = await ensurePersonalChannel(
        userId,
        workspaceId ?? undefined
      );
      telegramChannelId = personalChannel.id;
    }

    apiLogger.info(
      { telegramUserId, userId, workspaceId },
      "Telegram Mini App auth successful"
    );

    return c.json({
      token: sessionToken,
      userId,
      workspaceId,
      telegramChannelId,
      podUrl:
        process.env.PUBLIC_URL ||
        process.env.BACKEND_URL ||
        "http://localhost:3000",
    });
  } catch (error) {
    apiLogger.error({ err: error }, "Telegram auth endpoint error");
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ---------------------------------------------------------------------------
// Telegram Auto-Link Endpoint
// Called after Cloud/Direct login when user already has a session.
// Accepts initData + session token → validates HMAC → upserts channel_connection.
// This bridges the gap: user logged in via CP but hasn't done /link yet.
// ---------------------------------------------------------------------------
app.post("/api/auth/telegram-link", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { initData } = body as { initData?: string };

    if (!initData || typeof initData !== "string") {
      return c.json({ error: "initData is required" }, 400);
    }

    // Authenticate the caller via session cookie/header
    const authHeader = c.req.header("Authorization");
    const cookieHeader = c.req.header("Cookie");
    const kratosPublicUrl =
      process.env.KRATOS_PUBLIC_URL || "http://localhost:4433";

    let sessionIdentityId: string | null = null;

    // Try session token from Authorization header
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const whoamiRes = await fetch(`${kratosPublicUrl}/sessions/whoami`, {
        headers: { "X-Session-Token": token },
      });
      if (whoamiRes.ok) {
        const session = (await whoamiRes.json()) as {
          identity?: { id?: string };
        };
        sessionIdentityId = session.identity?.id ?? null;
      }
    }

    // Try session from cookie
    if (!sessionIdentityId && cookieHeader) {
      const match = cookieHeader.match(/ory_kratos_session=([^;]+)/);
      if (match) {
        const whoamiRes = await fetch(`${kratosPublicUrl}/sessions/whoami`, {
          headers: { Cookie: `ory_kratos_session=${match[1]}` },
        });
        if (whoamiRes.ok) {
          const session = (await whoamiRes.json()) as {
            identity?: { id?: string };
          };
          sessionIdentityId = session.identity?.id ?? null;
        }
      }
    }

    if (!sessionIdentityId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    // Validate Telegram initData HMAC
    const { resolveTelegramBotToken } = await import("@synap/api");
    const botToken = await resolveTelegramBotToken();
    if (!botToken) {
      return c.json({ error: "Telegram not configured on this pod" }, 503);
    }

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) {
      return c.json({ error: "Missing hash in initData" }, 401);
    }

    params.delete("hash");
    const entries = Array.from(params.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();
    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (computedHash !== hash) {
      return c.json({ error: "Invalid initData signature" }, 401);
    }

    // Extract Telegram user
    const userRaw = params.get("user");
    if (!userRaw) {
      return c.json({ error: "Missing user in initData" }, 401);
    }

    let telegramUser: { id: number; username?: string; first_name?: string };
    try {
      telegramUser = JSON.parse(userRaw);
    } catch {
      return c.json({ error: "Invalid user JSON" }, 401);
    }

    const telegramUserId = String(telegramUser.id);

    // Upsert channel_connection
    const { db, eq, and } = await import("@synap/database");
    const { channelConnections } = await import("@synap/database/schema");
    const { ensurePersonalChannel } = await import("@synap/api");

    // Check if connection already exists
    const existing = await db.query.channelConnections.findFirst({
      where: and(
        eq(channelConnections.channel, "telegram"),
        eq(channelConnections.channelUserId, telegramUserId)
      ),
    });

    if (existing) {
      // Already linked — return success with existing data
      return c.json({
        linked: true,
        alreadyExisted: true,
        userId: existing.userId,
        workspaceId: existing.workspaceId,
        telegramChannelId: existing.defaultChannelId,
      });
    }

    // Find user's first workspace
    const userWorkspaces = await db.query.workspaces.findMany({
      limit: 1,
    });
    const workspaceId = userWorkspaces[0]?.id ?? null;

    // Ensure a personal channel exists
    let telegramChannelId: string | null = null;
    if (workspaceId) {
      const personalChannel = await ensurePersonalChannel(
        sessionIdentityId,
        workspaceId
      );
      telegramChannelId = personalChannel.id;
    }

    // Insert the connection
    await db.insert(channelConnections).values({
      channel: "telegram",
      channelUserId: telegramUserId,
      userId: sessionIdentityId,
      workspaceId,
      defaultChannelId: telegramChannelId,
      externalUsername:
        telegramUser.username || telegramUser.first_name || null,
    });

    apiLogger.info(
      { telegramUserId, userId: sessionIdentityId, workspaceId },
      "Telegram auto-linked via Mini App"
    );

    return c.json({
      linked: true,
      alreadyExisted: false,
      userId: sessionIdentityId,
      workspaceId,
      telegramChannelId,
    });
  } catch (error) {
    apiLogger.error({ err: error }, "Telegram auto-link endpoint error");
    return c.json({ error: "Internal server error" }, 500);
  }
});

apiLogger.info(
  "Ory Kratos routes enabled at /.ory/kratos/public/* and /self-service/*"
);
apiLogger.info("Token Exchange endpoint enabled at /api/auth/token-exchange");
apiLogger.info("Control Plane handshake endpoint enabled at /api/handshake");
apiLogger.info(
  "Telegram auto-link endpoint enabled at /api/auth/telegram-link"
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

  // Get CORS origin for SSE response
  const getAllowedOrigin = (): string => {
    const allowedOrigins = getCorsOrigins();
    const origin = c.req.header("origin") || "";

    if (Array.isArray(allowedOrigins)) {
      return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
    }
    return allowedOrigins;
  };

  const allowOrigin = getAllowedOrigin();

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
