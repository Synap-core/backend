/**
 * Hub Protocol Rate Limiter
 *
 * Per-API-key sliding window rate limiting for Hub Protocol procedures.
 * Keyed by apiKeyId (not userId) — one user can have multiple keys with
 * different purposes; rate limiting per-key prevents one hot service
 * from starving others.
 *
 * In-memory store (same pattern as ai-rate-limit.ts). Replace with Redis
 * for multi-instance deployments.
 */

import { TRPCError } from "@trpc/server";

interface WindowEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, WindowEntry>();

const LIMITS: Record<string, { windowMs: number; max: number }> = {
  sendExternalMessage: { windowMs: 60_000, max: 60 },
  postToA2AIChannel: { windowMs: 60_000, max: 100 },
  pollA2AIChannel: { windowMs: 60_000, max: 200 },
  createExternalChannel: { windowMs: 60_000, max: 20 },
  /** MCP endpoint: 100 req/min per API key (prevents single compromised key from flooding) */
  mcp: { windowMs: 60_000, max: 100 },
  default: { windowMs: 60_000, max: 300 },
};

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (entry.resetAt < now) store.delete(key);
  }
}, 60_000);

/**
 * Check and increment rate limit for a given API key + procedure.
 * Throws TRPCError(TOO_MANY_REQUESTS) if the limit is exceeded.
 */
export function checkHubRateLimit(
  apiKeyId: string | undefined,
  procedure: string
): void {
  if (!apiKeyId) return; // No key context — skip (degraded mode)

  const { windowMs, max } = LIMITS[procedure] ?? LIMITS.default;
  const storeKey = `hub:${apiKeyId}:${procedure}`;
  const now = Date.now();

  const entry = store.get(storeKey);

  if (!entry || entry.resetAt < now) {
    store.set(storeKey, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (entry.count >= max) {
    const resetIn = Math.ceil((entry.resetAt - now) / 1000);
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Hub Protocol rate limit exceeded for ${procedure}. Retry after ${resetIn}s.`,
      cause: { limit: max, windowMs, resetIn },
    });
  }

  entry.count++;
}
