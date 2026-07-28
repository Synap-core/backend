/**
 * Security Middleware
 *
 * Implements defense-in-depth security measures:
 * - Multi-class rate limiting (prevent DoS; fair per API key / IP)
 * - Request size limits (prevent memory exhaustion)
 * - Security headers (prevent XSS, clickjacking, etc.)
 */
import type { Context, MiddlewareHandler } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { getDynamicCorsOrigins } from "@synap/api";
import {
  buildRateLimitKey,
  classifyRateLimitPath,
  getRateLimitClassConfig,
  type RateLimitClass,
} from "./rate-limit-classes.js";

// Re-export pure helpers so existing import sites can stay on security.js
export {
  buildRateLimitKey,
  classifyRateLimitPath,
  getRateLimitClassConfig,
  hashBearerToken,
  type RateLimitClass,
} from "./rate-limit-classes.js";

function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

/**
 * Shared key-generator: class + Bearer-hash (or IP), with dev/localhost bypasses.
 * Bypass keys are unique so they never collide with a shared bucket.
 */
function classKeyGenerator(className: RateLimitClass) {
  return (c: Context): string => {
    // Bypass for test user (development only)
    if (
      process.env.NODE_ENV === "development" &&
      c.req.header("x-test-user-id")
    ) {
      return `test-bypass-${className}-` + Math.random();
    }

    const ip = clientIp(c);

    // In development, bypass if IP is unknown (local fetch / Inngest)
    if (process.env.NODE_ENV === "development" && ip === "unknown") {
      return `localhost-bypass-${className}-` + Math.random();
    }

    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
      return `localhost-bypass-${className}-` + Math.random();
    }

    return buildRateLimitKey(className, c.req.header("Authorization"), ip);
  };
}

function classHandler(
  className: Exclude<RateLimitClass, "free">,
  limit: number,
  retryAfter: string
) {
  return (c: Context) =>
    c.json(
      {
        error: "Too many requests",
        message: "Rate limit exceeded. Please try again later.",
        retryAfter,
        class: className,
        limit,
      },
      429
    );
}

const rateLimitClassConfig = getRateLimitClassConfig();

const importRateLimiter = rateLimiter({
  windowMs: rateLimitClassConfig.import.windowMs,
  limit: rateLimitClassConfig.import.max,
  standardHeaders: "draft-7",
  keyGenerator: classKeyGenerator("import"),
  handler: classHandler(
    "import",
    rateLimitClassConfig.import.max,
    rateLimitClassConfig.import.retryAfter
  ),
});

const aiInteractiveRateLimiter = rateLimiter({
  windowMs: rateLimitClassConfig.ai_interactive.windowMs,
  limit: rateLimitClassConfig.ai_interactive.max,
  standardHeaders: "draft-7",
  keyGenerator: classKeyGenerator("ai_interactive"),
  handler: classHandler(
    "ai_interactive",
    rateLimitClassConfig.ai_interactive.max,
    rateLimitClassConfig.ai_interactive.retryAfter
  ),
});

const aiAgentTurnRateLimiter = rateLimiter({
  windowMs: rateLimitClassConfig.ai_agent_turn.windowMs,
  limit: rateLimitClassConfig.ai_agent_turn.max,
  standardHeaders: "draft-7",
  keyGenerator: classKeyGenerator("ai_agent_turn"),
  handler: classHandler(
    "ai_agent_turn",
    rateLimitClassConfig.ai_agent_turn.max,
    rateLimitClassConfig.ai_agent_turn.retryAfter
  ),
});

const crudRateLimiter = rateLimiter({
  windowMs: rateLimitClassConfig.crud.windowMs,
  limit: rateLimitClassConfig.crud.max,
  standardHeaders: "draft-7",
  keyGenerator: classKeyGenerator("crud"),
  handler: classHandler(
    "crud",
    rateLimitClassConfig.crud.max,
    rateLimitClassConfig.crud.retryAfter
  ),
});

/**
 * Multi-class pod-edge rate limiting.
 *
 * Classifies by path, keys by Bearer token hash (or IP), and applies
 * per-class windows/limits. Health/metrics are skipped (unlimited).
 */
export const rateLimitMiddleware: MiddlewareHandler = async (c, next) => {
  const cls = classifyRateLimitPath(c.req.path);
  switch (cls) {
    case "free":
      return next();
    case "import":
      return importRateLimiter(c, next);
    case "ai_agent_turn":
      return aiAgentTurnRateLimiter(c, next);
    case "ai_interactive":
      return aiInteractiveRateLimiter(c, next);
    case "crud":
    default:
      return crudRateLimiter(c, next);
  }
};

/**
 * AI Endpoint Rate Limiting Middleware
 *
 * V1.0 Security Hardening: Stricter limits for AI endpoints
 *
 * Limits: 20 requests per 5 minutes per user (more restrictive)
 * Applied to endpoints that call AI services (chat, capture, etc.)
 *
 * Why stricter?
 * - AI API calls are expensive (cost per request)
 * - AI API calls are slow (can cause DoS if too many concurrent)
 * - Prevents abuse and cost explosion
 */
export const aiRateLimitMiddleware = rateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes (shorter window)
  limit: 20, // Max 20 requests per window (stricter limit)
  standardHeaders: "draft-7",
  keyGenerator: (c) => {
    // Bypass for test user (development only)
    if (
      process.env.NODE_ENV === "development" &&
      c.req.header("x-test-user-id")
    ) {
      return "test-bypass-" + Math.random(); // Unique key every time
    }

    // Bypass for localhost (Inngest, internal calls)
    const ip =
      c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";

    // In development, bypass if IP is unknown (often happens with local fetch/Inngest)
    if (process.env.NODE_ENV === "development" && ip === "unknown") {
      return "localhost-bypass-" + Math.random();
    }

    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
      return "localhost-bypass-" + Math.random();
    }

    // Try to use user ID from context if available (better than IP)
    // Fall back to IP if no user context
    const userId = (c as { userId?: string }).userId;
    if (userId) {
      return `user:${userId}`;
    }
    return ip;
  },
  handler: (c) => {
    return c.json(
      {
        error: "Too many AI requests",
        message:
          "AI endpoint rate limit exceeded. Please wait before making more requests.",
        retryAfter: "5 minutes",
        limit: 20,
        window: "5 minutes",
        class: "ai_trpc",
      },
      429
    );
  },
});

/**
 * Federated Exchange Rate Limiting Middleware
 *
 * /api/federation/exchange creates Kratos sessions — stricter than the global
 * limit.
 * 20 attempts per 15 minutes per IP prevents brute-force session minting.
 */
export const handshakeRateLimitMiddleware = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  keyGenerator: (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    if (process.env.NODE_ENV === "development") return "handshake-dev-bypass";
    return `handshake:${ip}`;
  },
  handler: (c) => {
    return c.json(
      {
        error: "Too many authentication attempts",
        message: "Rate limit exceeded. Please try again in 15 minutes.",
        retryAfter: "15 minutes",
        class: "handshake",
      },
      429
    );
  },
});

/**
 * A pending application connection is polled by the browser holding its
 * opaque continuation. Status itself cannot mint a session or mutate trust,
 * so it needs a separate budget that covers the documented 30-poll recovery
 * window without weakening the strict handoff/complete protections.
 */
export const applicationConnectionStatusRateLimitMiddleware = rateLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  keyGenerator: (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    if (process.env.NODE_ENV === "development") {
      return "application-connection-status-dev-bypass";
    }
    return `application-connection-status:${ip}`;
  },
  handler: (c) =>
    c.json(
      {
        error: "Too many connection status checks",
        message: "Please wait before checking this connection again.",
        retryAfter: "15 minutes",
        class: "application_connection_status",
      },
      429
    ),
});

/**
 * Request Size Limit Middleware
 *
 * Default: 10MB max request body.
 * Exception: Hub entity source-file attach (binary provenance / Superwhisper
 * WAV dogfood) allows 32MB — matches SOURCE_BLOB_MAX_BYTES. Path-scoped so
 * the rest of the surface stays at 10MB.
 */
export const requestSizeLimit: MiddlewareHandler = async (c, next) => {
  const contentLength = c.req.header("content-length");

  if (contentLength) {
    const size = parseInt(contentLength, 10);
    const path = c.req.path;
    // Bulk media: source-file attach OR combined store-unit (entity + WAV).
    const isBulkMedia =
      /\/entities\/[^/]+\/source-file\/?$/.test(path) ||
      path.endsWith("/source-file") ||
      path.includes("/import/store-unit");
    const maxSize = isBulkMedia
      ? 32 * 1024 * 1024 // 32MB — audio provenance
      : 10 * 1024 * 1024; // 10MB default

    if (size > maxSize) {
      return c.json(
        {
          error: "Payload too large",
          message: `Request body must be less than ${maxSize / 1024 / 1024}MB`,
          received: `${(size / 1024 / 1024).toFixed(2)}MB`,
        },
        413
      );
    }
  }

  return next();
};

/**
 * Security Headers Middleware
 *
 * Adds security headers to prevent common attacks
 */
export const securityHeadersMiddleware: MiddlewareHandler = async (c, next) => {
  await next();

  // Prevent clickjacking
  c.header("X-Frame-Options", "DENY");

  // Prevent MIME type sniffing
  c.header("X-Content-Type-Options", "nosniff");

  // Enable XSS protection
  c.header("X-XSS-Protection", "1; mode=block");

  // Referrer policy
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  // Content Security Policy (adjust for your needs)
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://api.openai.com;"
  );

  // HSTS (only in production)
  if (process.env.NODE_ENV === "production") {
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }

  // Permissions Policy (restrict features)
  c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
};

/**
 * CORS Configuration (already in server, but here for reference)
 */
/**
 * Get allowed CORS origins from environment variable
 *
 * Format: ALLOWED_ORIGINS=https://app1.example.com,https://app2.example.com,http://localhost:3000
 *
 * For production: Set ALLOWED_ORIGINS with all frontend domains that should access this backend
 * For development: Falls back to common localhost ports if not set
 *
 * @returns Array of allowed origin URLs
 */
export const getCorsOrigins = (): string[] => {
  const envOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : [];

  // Merge with dynamically configured origins (stored in DB, cached in memory)
  const dynamicOrigins = getDynamicCorsOrigins();
  const merged = [...new Set([...envOrigins, ...dynamicOrigins])];

  if (merged.length > 0) {
    return merged;
  }

  // Development fallback: common localhost ports
  if (process.env.NODE_ENV === "development") {
    return [
      "http://localhost:5173",
      "http://localhost:5174",
      "http://localhost:3000",
      "http://localhost:3030",
      "http://localhost:3001",
    ];
  }

  // Production with no origins configured — reject all
  console.warn(
    "⚠️  ALLOWED_ORIGINS not set in production. CORS will reject all origins."
  );
  return [];
};
