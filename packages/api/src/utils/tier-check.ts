/**
 * Tier Check Utility
 *
 * Verifies that a user's subscription tier satisfies a package's requiredTier
 * by calling the Control Plane's internal endpoint.
 *
 * Used in workspace creation routes to enforce server-side tier gating before
 * a package-based workspace is created.
 *
 * Also exports `requireTier` — a tRPC middleware factory that gates individual
 * procedures behind a minimum subscription tier, with 5-minute caching and
 * fail-closed behavior when the Control Plane is unreachable.
 */

import { config, createLogger } from "@synap-core/core";
import { TRPCError } from "@trpc/server";
import { middleware } from "../trpc.js";

const logger = createLogger({ module: "tier-check" });

// ---------------------------------------------------------------------------
// In-process tier cache (userId → { tier, expiresAt })
// Avoids a CP round-trip on every tRPC call. Entries expire after 5 minutes.
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  tier: string;
  expiresAt: number;
}

const tierCache = new Map<string, CacheEntry>();

function getCachedTier(userId: string): string | null {
  const entry = tierCache.get(userId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tierCache.delete(userId);
    return null;
  }
  return entry.tier;
}

function setCachedTier(userId: string, tier: string): void {
  tierCache.set(userId, { tier, expiresAt: Date.now() + CACHE_TTL_MS });
}

export const TIER_RANK: Record<string, number> = {
  solo: 1,
  pro: 2,
  team: 3,
  enterprise: 4,
};

/**
 * Fetch a user's subscription tier from the Control Plane via the internal API.
 *
 * Uses in-process caching (5 min TTL) to avoid a CP round-trip on every request.
 *
 * For the legacy `assertPackageTierAccess` path: returns 'solo' as a safe open
 * default when CP is unreachable (self-hosted pods may not have a CP at all).
 *
 * For the `requireTier` middleware path: pass `failClosed = true` to throw
 * SERVICE_UNAVAILABLE instead of defaulting to 'solo'.
 */
async function fetchUserTierFromCP(
  userId: string,
  failClosed = false
): Promise<string> {
  const cached = getCachedTier(userId);
  if (cached) return cached;

  const cpUrl = config.server.controlPlaneUrl;
  const cpKey = config.server.controlPlaneInternalKey;

  if (!cpUrl || !cpKey) {
    logger.debug("Control plane not configured — defaulting to 'solo' tier");
    return "solo";
  }

  try {
    const res = await fetch(`${cpUrl}/internal/users/${userId}/tier`, {
      headers: { "X-Internal-Key": cpKey },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      logger.warn(
        { userId, status: res.status },
        "CP tier lookup returned non-OK"
      );
      if (failClosed) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Unable to verify subscription tier. Please try again.",
        });
      }
      return "solo";
    }

    const data = (await res.json()) as { tier?: string };
    const tier = data.tier ?? "solo";
    setCachedTier(userId, tier);
    return tier;
  } catch (err) {
    if (err instanceof TRPCError) throw err;
    logger.warn({ err, userId }, "CP tier lookup failed");
    if (failClosed) {
      throw new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "Unable to verify subscription tier. Please try again.",
      });
    }
    return "solo";
  }
}

/**
 * Fetch the requiredTier for a package from the Control Plane's public endpoint.
 * Returns null (no restriction) when the package is not found or the CP is unavailable.
 */
async function fetchPackageRequiredTier(slug: string): Promise<string | null> {
  const cpUrl = config.server.controlPlaneUrl;
  if (!cpUrl) return null;

  try {
    const res = await fetch(`${cpUrl}/api/packages/${slug}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      package?: { requiredTier?: string | null };
    };
    return data.package?.requiredTier ?? null;
  } catch (err) {
    logger.warn(
      { err, slug },
      "Package tier lookup failed — treating as unrestricted"
    );
    return null;
  }
}

/**
 * tRPC middleware that gates a procedure behind a minimum subscription tier.
 *
 * Fails closed: if the Control Plane is unreachable, throws SERVICE_UNAVAILABLE
 * instead of silently granting access.
 *
 * Usage:
 *   export const aiChatProcedure = protectedProcedure.use(requireTier("solo"));
 *   export const advancedViewProcedure = protectedProcedure.use(requireTier("pro"));
 *   export const multiWorkspaceProcedure = protectedProcedure.use(requireTier("team"));
 */
export function requireTier(minTier: keyof typeof TIER_RANK) {
  return middleware(async (opts) => {
    const { ctx, next } = opts;
    const userId = (ctx as { userId?: string }).userId;
    if (!userId) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }

    const cpUrl = config.server.controlPlaneUrl;
    if (!cpUrl) {
      // Self-hosted pod — no tier enforcement
      return next({ ctx });
    }

    const userTier = await fetchUserTierFromCP(userId, true /* failClosed */);
    const userRank = TIER_RANK[userTier] ?? 1;
    const requiredRank = TIER_RANK[minTier];

    if (userRank < requiredRank) {
      logger.warn(
        { userId, userTier, requiredTier: minTier },
        "requireTier: insufficient subscription"
      );
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `This feature requires a ${minTier} plan or higher. Please upgrade your subscription.`,
      });
    }

    return next({ ctx });
  });
}

/**
 * Assert that `userId` is allowed to install `packageSlug`.
 * Throws FORBIDDEN TRPCError if the user's tier is insufficient.
 * No-ops silently when the CP is not configured (self-hosted pods).
 */
export async function assertPackageTierAccess(
  userId: string,
  packageSlug: string
): Promise<void> {
  const cpUrl = config.server.controlPlaneUrl;
  if (!cpUrl) return; // Self-hosted pods have no tier restrictions

  // Fetch both in parallel to minimize latency
  const [requiredTier, userTier] = await Promise.all([
    fetchPackageRequiredTier(packageSlug),
    fetchUserTierFromCP(userId),
  ]);

  if (!requiredTier) return; // Package has no tier requirement

  const userRank = TIER_RANK[userTier] ?? 1;
  const requiredRank = TIER_RANK[requiredTier] ?? 0;

  if (userRank < requiredRank) {
    logger.warn(
      { userId, packageSlug, userTier, requiredTier },
      "Tier check failed: insufficient subscription"
    );
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `This template requires a ${requiredTier} plan. Please upgrade your subscription.`,
    });
  }
}
