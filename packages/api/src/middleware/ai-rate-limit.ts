/**
 * AI Rate Limiting Middleware for tRPC
 *
 * V1.0 Security Hardening: Stricter rate limiting for AI endpoints
 *
 * This middleware applies rate limiting to tRPC procedures that call AI services.
 * It uses an in-memory store (can be replaced with Redis for distributed systems).
 */

import { TRPCError } from "@trpc/server";
import { t } from "../init-trpc.js";

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
function checkRateLimit(
  key: string,
  limit: { max: number; windowMs: number } = {
    max: MAX_REQUESTS,
    windowMs: WINDOW_MS,
  }
): {
  allowed: boolean;
  remaining: number;
  resetAt: number;
} {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetAt < now) {
    // Create new entry or reset expired entry
    const resetAt = now + limit.windowMs;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit.max - 1, resetAt };
  }

  if (entry.count >= limit.max) {
    // Rate limit exceeded
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  // Increment count
  entry.count++;
  return {
    allowed: true,
    remaining: limit.max - entry.count,
    resetAt: entry.resetAt,
  };
}

/**
 * A per-person limit on ONE door that is not an AI call (its own counter, not
 * the AI one): `name` keys the counter, `max` requests per `windowMs`.
 */
export interface UserRateLimit {
  name: string;
  max: number;
  windowMs: number;
}

/**
 * Throw TOO_MANY_REQUESTS when `userId` passed `limit` on its door — the same
 * store and error as the AI limit, a counter of its own. Callable from a tRPC
 * procedure and a Hub REST route alike, so both doors share one budget.
 */
export function assertUserRateLimit(
  userId: string,
  limit: UserRateLimit
): void {
  const result = checkRateLimit(`door:${limit.name}:user:${userId}`, limit);
  if (!result.allowed) {
    const resetIn = Math.max(
      1,
      Math.ceil((result.resetAt - Date.now()) / 1000)
    );
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Too many requests to ${limit.name}. Please wait ${resetIn} seconds.`,
      cause: {
        limit: limit.max,
        windowMs: limit.windowMs,
        resetIn,
        resetAt: new Date(result.resetAt).toISOString(),
      },
    });
  }
}

/** {@link assertUserRateLimit} as tRPC middleware (keyed by `ctx.userId`). */
export function userRateLimitMiddleware(limit: UserRateLimit) {
  return t.middleware(async (opts) => {
    assertUserRateLimit(opts.ctx.userId ?? "unknown", limit);
    return opts.next({ ctx: opts.ctx });
  });
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
/**
 * The same AI rate limit, for a door that spends AI only on SOME inputs
 * (e.g. `library.add` with Read now): throws TOO_MANY_REQUESTS like the
 * middleware. Shares the middleware's counter.
 */
export function assertAiRateLimit(userId: string): void {
  const result = checkRateLimit(`ai:user:${userId}`);
  if (!result.allowed) {
    const resetIn = Math.ceil((result.resetAt - Date.now()) / 1000);
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `AI endpoint rate limit exceeded. Please wait ${resetIn} seconds before making more requests.`,
    });
  }
}

export const aiRateLimitMiddleware = t.middleware(async (opts) => {
  const { ctx } = opts;

  // Generate rate limit key (prefer user ID over IP)
  let key: string;
  if (ctx.userId) {
    key = `ai:user:${ctx.userId}`;
  } else {
    // Fallback to IP if no user context (shouldn't happen in protected procedures)
    key = `ai:ip:unknown`;
  }

  const result = checkRateLimit(key);

  if (!result.allowed) {
    const resetIn = Math.ceil((result.resetAt - Date.now()) / 1000);
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `AI endpoint rate limit exceeded. Please wait ${resetIn} seconds before making more requests.`,
      cause: {
        limit: MAX_REQUESTS,
        window: "5 minutes",
        resetIn,
        resetAt: new Date(result.resetAt).toISOString(),
      },
    });
  }

  // Rate limit info: remaining=${result.remaining}, resetAt=${result.resetAt}
  // tRPC doesn't expose response headers directly, so metadata is logged only.

  return opts.next({
    ctx,
  });
});
