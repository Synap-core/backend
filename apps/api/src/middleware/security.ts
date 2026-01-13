/**
 * Security Middleware
 *
 * Implements defense-in-depth security measures:
 * - Rate limiting (prevent DoS)
 * - Request size limits (prevent memory exhaustion)
 * - Security headers (prevent XSS, clickjacking, etc.)
 */

import type { MiddlewareHandler } from "hono";
import { rateLimiter } from "hono-rate-limiter";

/**
 * Rate Limiting Middleware (General)
 *
 * Limits: 100 requests per 15 minutes per IP
 * Applied to all routes by default
 */
export const rateLimitMiddleware = rateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100, // Max 100 requests per window
  standardHeaders: "draft-7", // Use standard RateLimit headers
  keyGenerator: (c) => {
    // Bypass for test user
    if (c.req.header("x-test-user-id")) {
      return "test-bypass-" + Math.random(); // Unique key every time to avoid hitting limit
    }

    // Bypass for localhost (Inngest, internal calls)
    const ip =
      c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    console.log("DEBUG: Rate Limit IP:", ip);

    // In development, bypass if IP is unknown (often happens with local fetch/Inngest)
    if (process.env.NODE_ENV === "development" && ip === "unknown") {
      return "localhost-bypass-" + Math.random();
    }

    if (ip === "127.0.0.1" || ip === "::1" || ip === "localhost") {
      return "localhost-bypass-" + Math.random();
    }

    // Use IP address as key
    return ip;
  },
  handler: (c) => {
    return c.json(
      {
        error: "Too many requests",
        message: "Rate limit exceeded. Please try again later.",
        retryAfter: "15 minutes",
      },
      429,
    );
  },
});

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
    // Bypass for test user
    if (c.req.header("x-test-user-id")) {
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
    const userId = (c as any).userId;
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
      },
      429,
    );
  },
});

/**
 * Request Size Limit Middleware
 *
 * Limit: 10MB max request body
 */
export const requestSizeLimit: MiddlewareHandler = async (c, next) => {
  const contentLength = c.req.header("content-length");

  if (contentLength) {
    const size = parseInt(contentLength, 10);
    const maxSize = 10 * 1024 * 1024; // 10MB

    if (size > maxSize) {
      return c.json(
        {
          error: "Payload too large",
          message: `Request body must be less than ${maxSize / 1024 / 1024}MB`,
          received: `${(size / 1024 / 1024).toFixed(2)}MB`,
        },
        413,
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
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://api.anthropic.com https://api.openai.com;",
  );

  // HSTS (only in production)
  if (process.env.NODE_ENV === "production") {
    c.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }

  // Permissions Policy (restrict features)
  c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
};

/**
 * CORS Configuration (already in server, but here for reference)
 */
export const getCorsOrigins = () => {
  const origins = process.env.ALLOWED_ORIGINS?.split(",") || [
    "http://localhost:5173", // Vite dev (default)
    "http://localhost:5174", // Vite dev (alternative port)
    "http://localhost:3000", // Next.js dev
    "http://localhost:3001", // Alternative port
  ];

  // Add production origin from Kratos UI URL
  if (process.env.KRATOS_UI_URL) {
    origins.push(process.env.KRATOS_UI_URL);
  }

  return origins;
};
