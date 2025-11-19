/**
 * AI Rate Limiting Middleware for tRPC
 * 
 * V1.0 Security Hardening: Stricter rate limiting for AI endpoints
 * 
 * This middleware applies rate limiting to tRPC procedures that call AI services.
 * It uses an in-memory store (can be replaced with Redis for distributed systems).
 */

import { TRPCError } from '@trpc/server';
import { middleware } from '../trpc.js';

// Simple in-memory rate limit store
// In production, replace with Redis for distributed systems
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Configuration
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_REQUESTS = 20; // Max 20 requests per window

/**
 * Clean up expired entries (simple garbage collection)
 */
function cleanupExpiredEntries() {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredEntries, 60 * 1000);

/**
 * Check if a request should be rate limited
 */
function checkRateLimit(key: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt < now) {
    // Create new entry or reset expired entry
    const resetAt = now + WINDOW_MS;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: MAX_REQUESTS - 1, resetAt };
  }

  if (entry.count >= MAX_REQUESTS) {
    // Rate limit exceeded
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  // Increment count
  entry.count++;
  return { allowed: true, remaining: MAX_REQUESTS - entry.count, resetAt: entry.resetAt };
}

/**
 * AI Rate Limiting Middleware
 * 
 * Applies stricter rate limiting to procedures that call AI services.
 * 
 * Usage:
 * ```typescript
 * export const chatRouter = router({
 *   sendMessage: protectedProcedure
 *     .use(aiRateLimitMiddleware)
 *     .mutation(async ({ ctx, input }) => {
 *       // AI call here
 *     }),
 * });
 * ```
 */
export const aiRateLimitMiddleware = middleware(async (opts) => {
  const { ctx } = opts;

  // Generate rate limit key (prefer user ID over IP)
  let key: string;
  if (ctx.userId) {
    key = `ai:user:${ctx.userId}`;
  } else {
    // Fallback to IP if no user context (shouldn't happen in protected procedures)
    key = `ai:ip:${(opts as any).req?.headers?.['x-forwarded-for'] || 'unknown'}`;
  }

  const result = checkRateLimit(key);

  if (!result.allowed) {
    const resetIn = Math.ceil((result.resetAt - Date.now()) / 1000);
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `AI endpoint rate limit exceeded. Please wait ${resetIn} seconds before making more requests.`,
      cause: {
        limit: MAX_REQUESTS,
        window: '5 minutes',
        resetIn,
        resetAt: new Date(result.resetAt).toISOString(),
      },
    });
  }

  // Add rate limit headers to response (if possible)
  // Note: tRPC doesn't expose response headers directly, but we can add metadata
  (opts as any)._rateLimit = {
    remaining: result.remaining,
    resetAt: result.resetAt,
  };

  return opts.next({
    ctx,
  });
});

