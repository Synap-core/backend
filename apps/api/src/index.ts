/**
 * Synap API Server
 *
 * Hono server with:
 * - tRPC API endpoints
 * - Ory Kratos routes (session-based authentication)
 * - Token Exchange endpoint
 * - Inngest handler
 */

// Load environment variables from .env
import "dotenv/config";

// Initialize OpenTelemetry tracing FIRST (before any other imports)
// This must be done before importing any libraries to ensure proper instrumentation
// TODO: Enable tracing for production observability
// import { initializeTracing } from "@synap-core/core";
// initializeTracing();

import { Hono, type Context as HonoContext } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
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
} from "@synap/api";
import { serve } from "@hono/node-server";
import { serve as inngestServe } from "inngest/hono";
import { inngest, functions } from "@synap/jobs";
import crypto from "crypto";
import { getCorsOrigins } from "./middleware/security.js";
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

// Security Middleware (Applied First)
// TODO: Enable rate limiting and request size limits for production
// app.use("*", requestSizeLimit); // Max 10MB requests
// app.use("*", rateLimitMiddleware); // 100 req/15min per IP
app.use("*", secureHeaders()); // Hono built-in security headers
apiLogger.info("Security middleware registered");

// Logging & CORS
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => {
      // Accept any origin when credentials are required
      // Browser requires specific origin (not wildcard) when credentials: true
      // So we return the requesting origin if present
      if (!origin) {
        // Same-origin request (no Origin header) - allow by returning null
        return null;
      }
      // Return the requesting origin (allows any origin)
      // Security is handled by authentication, not CORS
      return origin;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    exposeHeaders: ["Content-Length", "X-Request-Id", "Set-Cookie"],
    maxAge: 86400, // 24 hours
  })
);

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
    });

    // Get all response headers
    const responseHeaders = new Headers();
    response.headers.forEach((value, key) => {
      responseHeaders.set(key, value);
    });

    // Return Response object (Hono accepts Response directly)
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    apiLogger.error(
      { err: error, path: kratosPath },
      "Error proxying Kratos request"
    );
    return c.json({ error: "Internal server error" }, 500);
  }
};

// Production route: /.ory/kratos/public/* (matches Caddy routing)
// This allows the frontend middleware to always use the same path
app.all("/.ory/kratos/public/*", async (c) => {
  // Remove /.ory/kratos/public prefix, keep the rest
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

apiLogger.info(
  "Ory Kratos routes enabled at /.ory/kratos/public/* and /self-service/*"
);
apiLogger.info("Token Exchange endpoint enabled at /api/auth/token-exchange");

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

  // Return Response object (Hono accepts Response directly)
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Credentials": "true",
    },
  });
});

// tRPC routes (protected by auth, except public routes)
app.use("/trpc/*", async (c, next) => {
  const path = c.req.path;

  // Public routes that don't require authentication
  const isHealthRoute = path.includes("health.");
  const isSystemRoute = path.includes("system.");
  const isSetupRoute = path.includes("setup.");
  const isDev = config.server.nodeEnv === "development";

  // In development, allow public access to system.* and health.* routes
  // In production, health.* and setup.* routes are always public
  if (isHealthRoute || isSetupRoute || (isSystemRoute && isDev)) {
    apiLogger.debug({ path }, "Bypassing auth for public route");
    return next();
  }

  // Apply Kratos session-based auth middleware for all protected routes
  // This validates the session cookie with Kratos and sets user context
  return authMiddleware(c, next);
});

// Admin routes (public API for invitations)
import { adminRouter } from "./routers/admin.js";
app.route("/api/admin", adminRouter);

// Webhook routes (before auth - uses webhook secret auth)
import { webhookRouter } from "./webhooks/index.js";
app.route("/webhooks", webhookRouter);

// Hub Protocol REST adapter (for Intelligence Service; API key auth)
app.route("/api/hub", hubProtocolRestApp);

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

// Inngest handler (for background jobs)
app.use(
  "/api/inngest",
  inngestServe({
    client: inngest,
    functions,
  })
);
apiLogger.info("Inngest handler registered at /api/inngest");

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
const EVENT_PROCESSOR_START_DELAY_MS = 5000; // Delay to allow server to bind port first

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

      // Start event processor (delayed to allow server to bind port first)
      const { startEventProcessor } = await import("@synap/api");
      setTimeout(() => {
        startEventProcessor();
        apiLogger.info("Event processor started");
      }, EVENT_PROCESSOR_START_DELAY_MS);
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

process.on("SIGTERM", () => {
  apiLogger.info("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

export default app;
