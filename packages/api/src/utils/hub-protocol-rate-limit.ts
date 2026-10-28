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
  /** File/blob upload door (POST /files): bound the unreviewed-upload vector. */
  files: { windowMs: 60_000, max: 30 },
  /** MCP endpoint: 100 req/min per API key (prevents single compromised key from flooding) */
  mcp: { windowMs: 60_000, max: 100 },
  default: { windowMs: 60_000, max: 300 },
};

/**
 * Config overrides, one env key per procedure. Empty or invalid = the code's
 * default above. Passed to a deployed pod by `deploy/docker-compose.yml` and
 * accepted by `deploy/env.schema` (`hub-protocol-rate-limit-wiring.test.ts`).
 */
const LIMIT_ENV: Record<string, string> = {
  mcp: "RATE_LIMIT_MCP_MAX",
};

/** The per-window maximum for a procedure: its env override, else the default. */
export function limitFor(procedure: string): number {
  const envKey = LIMIT_ENV[procedure];
  const raw = envKey ? process.env[envKey] : undefined;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (Number.isFinite(n) && n > 0) return n;
  return (LIMITS[procedure] ?? LIMITS.default).max;
}

/** What a 429 from this limiter carries: seconds until the window resets. */
export interface HubRateLimitCause {
  limit: number;
  windowMs: number;
  resetIn: number;
}

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

  const { windowMs } = LIMITS[procedure] ?? LIMITS.default;
  const max = limitFor(procedure);
  const storeKey = `hub:${apiKeyId}:${procedure}`;
  const now = Date.now();

  const entry = store.get(storeKey);

  if (!entry || entry.resetAt < now) {
    store.set(storeKey, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (entry.count >= max) {
    const resetIn = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: `Hub Protocol rate limit exceeded for ${procedure}. Retry after ${resetIn}s.`,
      cause: { limit: max, windowMs, resetIn } satisfies HubRateLimitCause,
    });
  }

  entry.count++;
}
