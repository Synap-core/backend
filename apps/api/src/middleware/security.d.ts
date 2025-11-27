/**
 * Security Middleware
 *
 * Implements defense-in-depth security measures:
 * - Rate limiting (prevent DoS)
 * - Request size limits (prevent memory exhaustion)
 * - Security headers (prevent XSS, clickjacking, etc.)
 */
import type { MiddlewareHandler } from 'hono';
/**
 * Rate Limiting Middleware (General)
 *
 * Limits: 100 requests per 15 minutes per IP
 * Applied to all routes by default
 */
export declare const rateLimitMiddleware: MiddlewareHandler<import("hono").Env, string, import("hono").Input>;
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
export declare const aiRateLimitMiddleware: MiddlewareHandler<import("hono").Env, string, import("hono").Input>;
/**
 * Request Size Limit Middleware
 *
 * Limit: 10MB max request body
 */
export declare const requestSizeLimit: MiddlewareHandler;
/**
 * Security Headers Middleware
 *
 * Adds security headers to prevent common attacks
 */
export declare const securityHeadersMiddleware: MiddlewareHandler;
/**
 * CORS Configuration (already in server, but here for reference)
 */
export declare const getCorsOrigins: () => string[];
//# sourceMappingURL=security.d.ts.map