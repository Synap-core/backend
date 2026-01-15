/**
 * Synap API Server
 *
 * Hono server with:
 * - tRPC API endpoints
 * - Ory Kratos routes (PostgreSQL only)
 * - Token Exchange endpoint
 * - Inngest handler
 */

// Load environment variables from .env
console.log("DEBUG: apps/api/src/index.ts starting evaluation");
import "dotenv/config";

// Initialize OpenTelemetry tracing FIRST (before any other imports)
// This must be done before importing any libraries to ensure proper instrumentation
// import { initializeTracing } from "@synap-core/core";
// initializeTracing();

import { Hono } from "hono";
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
import { appRouter /*, createContext */ } from "@synap/api"; // createContext disabled - type mismatch
import { serve } from "@hono/node-server";
import { serve as inngestServe } from "inngest/hono";
import { inngest, functions } from "@synap/jobs";
import crypto from "crypto";
/*
import {
  rateLimitMiddleware,
  requestSizeLimit,
  securityHeadersMiddleware,
  getCorsOrigins,
} from "./middleware/security.js";
*/
import { eventStreamManager, setupEventBroadcasting } from "@synap/api";
// import { webhookRouter } from "./webhooks/index.js";

console.log("🔍 DEBUG: Starting API server index.ts execution");

// Setup event broadcasting to SSE clients
const debugLogger = createLogger({ module: "api-debug" });
debugLogger.info("🔍 DEBUG: Execution reached index.ts top-level");
setupEventBroadcasting();
debugLogger.info("🔍 DEBUG: setupEventBroadcasting() returned");

// Validate configuration at startup
const apiLogger = createLogger({ module: "api-server" });
apiLogger.info("🔍 DEBUG: Validating configuration");

try {
  // Validate database config
  if (config.database.dialect === "postgres") {
    validateConfig("postgres");
    apiLogger.info("PostgreSQL configuration validated");
  }

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
        "R2 provider selected but credentials missing - should auto-switch to MinIO",
      );
    }
  } else {
    apiLogger.info(
      { provider: config.storage.provider },
      "Storage provider configured",
    );
  }

  // Validate AI config in production
  if (config.server.nodeEnv === "production") {
    validateConfig("ai");
    apiLogger.info("AI configuration validated");
  }

  // Validate auth config for PostgreSQL
  if (config.database.dialect === "postgres") {
    validateConfig("ory");
    apiLogger.info("Ory Stack configuration validated");
  }
} catch (error) {
  apiLogger.error({ err: error }, "Configuration validation failed");
  console.error(
    "❌ Configuration Error:",
    error instanceof Error ? error.message : String(error),
  );
  console.error("Please check your environment variables and configuration.");
  process.exit(1);
}

// Static import to avoid dynamic import hangs (circular dep with @synap/api?)
import * as oryAuth from "@synap/auth";

// Dynamic auth import based on DB dialect
const isPostgres = config.database.dialect === "postgres";
let authMiddleware: any = null;

if (isPostgres) {
  // PostgreSQL: Ory Stack (Kratos + Hydra)
  authMiddleware = oryAuth.authMiddleware; // Uses orySessionMiddleware for session-based auth
} else {
  // SQLite: Simple token auth (not implemented in PostgreSQL-only version)
  // For SQLite mode, we would need to implement simple token auth
  // For now, PostgreSQL-only version uses Ory
  throw new Error("SQLite mode not supported in PostgreSQL-only version");
}

console.log("🔍 DEBUG: Initializing Hono app");
const app = new Hono();

// Security Middleware (Applied First)
console.log("🔍 DEBUG: Registering security middleware");
// app.use("*", requestSizeLimit); // Max 10MB requests
// app.use("*", rateLimitMiddleware); // 100 req/15min per IP
// app.use("*", securityHeadersMiddleware); // Security headers
app.use("*", secureHeaders()); // Hono built-in security
console.log("🔍 DEBUG: Security middleware registered");

// Logging & CORS
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: "*", // getCorsOrigins(),
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    exposeHeaders: ["Content-Length", "X-Request-Id", "Set-Cookie"],
    maxAge: 86400, // 24 hours
  }),
);

// Health check (public, no auth)
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: isPostgres ? "0.2.0-saas" : "0.1.0-local",
    mode: isPostgres ? "multi-user" : "single-user",
    auth: isPostgres ? "ory-stack" : "static-token",
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

// Ory Kratos routes (PostgreSQL only)
// Kratos handles its own routes via public API
// We proxy the necessary endpoints for browser-based flows
if (isPostgres) {
  // Proxy Kratos self-service flows
  app.get("/self-service/*", async (c) => {
    const path = c.req.path.replace("/self-service", "");
    try {
      // Forward request to Kratos public API
      const response = await fetch(
        `${process.env.KRATOS_PUBLIC_URL || "http://localhost:4433"}${path}`,
        {
          method: c.req.method,
          headers: {
            Cookie: c.req.header("cookie") || "",
          },
        },
      );

      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      apiLogger.error({ err: error, path }, "Error proxying Kratos request");
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // Token Exchange endpoint (for websites with external providers)
  app.post("/api/auth/token-exchange", async (c) => {
    try {
      const body = await c.req.json();
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

  apiLogger.info("Ory Kratos routes enabled at /self-service/*");
  apiLogger.info("Token Exchange endpoint enabled at /api/auth/token-exchange");
}

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

  // Get CORS origins
  const allowedOrigins = getCorsOrigins();
  const origin = c.req.header("origin") || "";
  const allowOrigin = Array.isArray(allowedOrigins)
    ? allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0]
    : allowedOrigins;

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

  // Apply Kratos auth middleware for all protected routes
  return authMiddleware(c, next);
});

// Webhook routes (before auth - uses webhook secret auth)
// app.route("/webhooks", webhookRouter);

// tRPC endpoint
app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    // We use 'any' for the second argument to handle version differences in @hono/trpc-server
    // In newer versions, the Hono Context is passed as the second argument
    createContext: async (opts, c: any) => {
      // Get database
      const { getDb } = await import("@synap/database");
      const db = await getDb();

      // Check if Hono middleware set auth data (from orySessionMiddleware)
      // The context is passed as the second argument in newer @hono/trpc-server versions
      // We check both opts.c (older) and c (newer)
      const ctx = (opts as any).c || c;
      const userId = ctx?.get?.("userId");
      const user = ctx?.get?.("user");
      const session = ctx?.get?.("session");
      const authenticated = ctx?.get?.("authenticated");

      if (authenticated && userId) {
        // Auth middleware validated session
        return {
          db,
          authenticated: true,
          userId,
          user,
          session,
          req: (opts as any).c?.req?.raw || opts.req,
        };
      }

      // No auth - return unauthenticated context
      return {
        db,
        authenticated: false,
        userId: null,
        user: null,
        session: null,
        req: (opts as any).c?.req?.raw || opts.req,
      };
    },
    onError({ error, path }) {
      apiLogger.error({ err: error, path }, "tRPC error");
    },
  }),
);

console.log("🔍 DEBUG: About to register Inngest serve handler...");

// Inngest handler (for background jobs)
// Inngest handler (for background jobs)
app.use(
  "/api/inngest",
  inngestServe({
    client: inngest,
    functions,
  }),
);

console.log("✅ DEBUG: Inngest serve handler registered successfully!");

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not found" }, 404);
});

// Error handler
app.onError((err, c) => {
  const errorId = crypto.randomUUID();
  const apiLogger = createLogger({ module: "api-server" });

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
    synapError.statusCode >= 500 ? "Server error" : "Client error",
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
    statusCode,
  );
});

// Start server
// Start server
apiLogger.info("🔍 DEBUG: Calling serve() to start HTTP server...");
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
        "API server started",
      );

      // ✨ Start event processor (Delayed to allow server to bind port first)
      const { startEventProcessor } = await import("@synap/api");
      setTimeout(() => {
        startEventProcessor();
        apiLogger.info("Event processor started (delayed)");
      }, 5000);
    },
  );
} catch (err) {
  console.error("❌ CRITICAL: serve() threw an error:", err);
  process.exit(1);
}

// Run startup hooks after server is listening
import { runStartupHooks } from "./startup-hooks.js";
runStartupHooks().catch((err) => {
  apiLogger.error({ err }, "Startup hooks failed (non-fatal)");
});

process.on("SIGTERM", () => {
  console.log("⚠️ DEBUG: SIGTERM received!");
  apiLogger.info("SIGTERM received, shutting down gracefully");
  process.exit(0);
});

export default app;
