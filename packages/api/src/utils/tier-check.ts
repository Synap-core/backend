/**
 * Tier Check Utility
 *
 * Reads the subscription tier from the pod's local workspace settings
 * (workspace.settings.controlPlane.tier). The Control Plane pushes the tier
 * in every provision JWT and re-pushes it on subscription changes — no
 * runtime round-trip to the CP is ever needed.
 *
 * For self-hosted pods (no CP configured), returns 'solo' as the safe default.
 *
 * Exports:
 *   requireTier       — tRPC middleware factory for per-procedure tier gates
 *   assertPackageTierAccess — one-shot check used in workspace creation
 */

import { config, createLogger } from "@synap-core/core";
import { TRPCError } from "@trpc/server";
import { t } from "../init-trpc.js";
import { getDb } from "@synap/database";
import { signedRequiredTier } from "../services/capabilities/official-catalog-trust.js";

const logger = createLogger({ module: "tier-check" });

// ---------------------------------------------------------------------------
// In-process tier cache (TTL: 5 min — avoids DB read on every tRPC call)
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  tier: string;
  expiresAt: number;
}

// Keyed by a fixed string — the tier is pod-level, same for all users
const tierCache = new Map<"pod", CacheEntry>();

function getCachedTier(): string | null {
  const entry = tierCache.get("pod");
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tierCache.delete("pod");
    return null;
  }
  return entry.tier;
}

function setCachedTier(tier: string): void {
  tierCache.set("pod", { tier, expiresAt: Date.now() + CACHE_TTL_MS });
}

export const TIER_RANK: Record<string, number> = {
  solo: 1,
  pro: 2,
  team: 3,
  enterprise: 4,
};

// ---------------------------------------------------------------------------
// Core: read tier from workspace.settings.controlPlane.tier
// ---------------------------------------------------------------------------

/**
 * Get the pod's subscription tier from the local workspace settings.
 *
 * Returns 'solo' when:
 *   - No CP is configured (self-hosted pod)
 *   - No tier has been pushed yet (pod provisioned before this feature)
 *   - DB read fails
 */
async function getLocalTier(): Promise<string> {
  const cpUrl = config.server.controlPlaneUrl;
  if (!cpUrl) {
    // Self-hosted pod — no tier enforcement
    return "solo";
  }

  const cached = getCachedTier();
  if (cached) return cached;

  try {
    const db = await getDb();
    const ws = await db.query.workspaces.findFirst({
      columns: { settings: true },
    });

    const settings = (ws?.settings as Record<string, unknown>) ?? {};
    const cp = settings.controlPlane as { tier?: string } | undefined;
    const tier = cp?.tier ?? "solo";

    setCachedTier(tier);
    return tier;
  } catch (err) {
    logger.warn({ err }, "getLocalTier: DB read failed — defaulting to 'solo'");
    return "solo";
  }
}

/**
 * The requiredTier of a package. Once Synap's catalog signature is enforced,
 * the tier its verified index lists wins over the Control Plane's unsigned
 * answer; until then the unsigned answer is used and a disagreement is
 * logged. Returns null (no restriction) when the package is not found or the
 * CP is unavailable.
 */
async function fetchPackageRequiredTier(slug: string): Promise<string | null> {
  const cpUrl = config.server.controlPlaneUrl;
  if (!cpUrl) return null;

  const signed = await signedRequiredTier(
    slug,
    (tier) => TIER_RANK[tier] ?? 0
  ).catch(() => null);
  if (signed?.enforce) return signed.tier;

  let tier: string | null;
  try {
    const res = await fetch(`${cpUrl}/api/packages/${slug}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      package?: { requiredTier?: string | null };
    };
    tier = data.package?.requiredTier ?? null;
  } catch (err) {
    logger.warn(
      { err, slug },
      "Package tier lookup failed — treating as unrestricted"
    );
    return null;
  }
  if (signed && signed.tier !== tier) {
    logger.warn(
      { slug, unsigned: tier, signed: signed.tier },
      "The Control Plane's tier for this package differs from Synap's signed catalog (report only)"
    );
  }
  return tier;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * tRPC middleware that gates a procedure behind a minimum subscription tier.
 *
 * Reads the tier from local workspace settings — no CP round-trip.
 * For self-hosted pods (no CP configured), all tiers are allowed.
 *
 * Usage:
 *   export const aiChatProcedure = protectedProcedure.use(requireTier("solo"));
 *   export const advancedViewProcedure = protectedProcedure.use(requireTier("pro"));
 */
export function requireTier(minTier: keyof typeof TIER_RANK) {
  return t.middleware(async (opts) => {
    const { ctx, next } = opts;
    const cpUrl = config.server.controlPlaneUrl;

    if (!cpUrl) {
      // Self-hosted pod — no tier enforcement
      return next({ ctx });
    }

    const userTier = await getLocalTier();
    const userRank = TIER_RANK[userTier] ?? 1;
    const requiredRank = TIER_RANK[minTier];

    if (userRank < requiredRank) {
      const userId = (ctx as { userId?: string }).userId;
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
 * Throws FORBIDDEN TRPCError if the pod's tier is insufficient.
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
    getLocalTier(),
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
