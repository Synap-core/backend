/**
 * Split-Brain Detection & Prevention Service
 *
 * Manages the sync_generation table to detect and respond to split-brain
 * scenarios in dual-pod redundancy setups.
 *
 * Key behaviors:
 * - Increments generation counter on each sync push cycle
 * - Exchanges generation info during sync push/pull
 * - Detects split-brain: both pods advanced generation during partition
 * - Demotes the pod with fewer writes to read-only
 * - Supports manual promotion via admin endpoint
 */

import {
  db,
  syncGeneration,
  syncPeers,
  eq,
  and,
  drizzleSql,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "split-brain-service" });

// ─── In-memory cache (avoid DB hit on every request) ────────────────────────

interface CachedState {
  role: string;
  splitBrainDetected: boolean;
  generation: number;
  lastPeerGeneration: number;
  lastPeerContact: Date | null;
}

let cachedState: CachedState | null = null;
let cacheRefreshedAt = 0;
const CACHE_TTL_MS = 5_000; // 5s — balance between freshness and DB load

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the current pod state (cached for 5s).
 * Returns role, generation, and split-brain status.
 */
export async function getSyncGenerationState(): Promise<CachedState> {
  const now = Date.now();
  if (cachedState && now - cacheRefreshedAt < CACHE_TTL_MS) {
    return cachedState;
  }

  const row = await db.query.syncGeneration.findFirst({
    where: eq(syncGeneration.id, "current"),
  });

  if (!row) {
    // No row yet — seed it
    await db
      .insert(syncGeneration)
      .values({ id: "current", generation: 0, role: "primary" })
      .onConflictDoNothing();

    cachedState = {
      role: "primary",
      splitBrainDetected: false,
      generation: 0,
      lastPeerGeneration: 0,
      lastPeerContact: null,
    };
  } else {
    cachedState = {
      role: row.role,
      splitBrainDetected: row.splitBrainDetected,
      generation: row.generation,
      lastPeerGeneration: row.lastPeerGeneration ?? 0,
      lastPeerContact: row.lastPeerContact,
    };
  }

  cacheRefreshedAt = now;
  return cachedState;
}

/** Force cache invalidation (after promote, etc.) */
export function invalidateSyncGenerationCache(): void {
  cachedState = null;
  cacheRefreshedAt = 0;
}

/**
 * Check whether this pod is in read-only mode due to split-brain demotion.
 * Uses the in-memory cache for performance (called on every write mutation).
 */
export async function isPodReadOnly(): Promise<boolean> {
  const state = await getSyncGenerationState();
  return state.role === "readonly";
}

/**
 * Increment the local generation counter.
 * Called once per sync push cycle (not per-event — avoids hot row contention).
 */
export async function incrementGeneration(): Promise<number> {
  const [updated] = await db
    .update(syncGeneration)
    .set({
      generation: drizzleSql`${syncGeneration.generation} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(syncGeneration.id, "current"))
    .returning({ generation: syncGeneration.generation });

  if (updated) {
    invalidateSyncGenerationCache();
    return updated.generation;
  }
  return 0;
}

/**
 * Record peer generation info received during sync.
 * Detects split-brain: if both local and remote generation advanced
 * since last contact, a partition occurred with concurrent writes.
 */
export async function recordPeerGeneration(
  peerGeneration: number,
  peerRole: string
): Promise<{ splitBrain: boolean }> {
  const state = await getSyncGenerationState();

  // If already in split-brain state, don't re-detect
  if (state.splitBrainDetected) {
    // Update peer contact time only
    await db
      .update(syncGeneration)
      .set({
        lastPeerContact: new Date(),
        lastPeerGeneration: peerGeneration,
        updatedAt: new Date(),
      })
      .where(eq(syncGeneration.id, "current"));

    invalidateSyncGenerationCache();
    return { splitBrain: true };
  }

  const localAdvanced = state.generation > state.lastPeerGeneration;
  const remoteAdvanced = peerGeneration > state.lastPeerGeneration;

  // Split-brain: both pods wrote during the partition gap
  // (both generations advanced beyond what we last knew about the peer)
  const isSplitBrain =
    localAdvanced &&
    remoteAdvanced &&
    state.lastPeerContact !== null && // Only detect after at least one successful contact
    peerGeneration !== state.generation; // Different generations = diverged

  if (isSplitBrain) {
    // Check if this pod is configured as `secondary` on ANY enabled peer.
    // A secondary pod is a local twin that must never be auto-demoted to readonly:
    // it is designed to accumulate offline writes and rely on LWW at reconnect.
    const secondaryPeer = await db.query.syncPeers.findFirst({
      where: and(
        eq(syncPeers.localRole, "secondary"),
        eq(syncPeers.enabled, true)
      ),
      columns: { id: true },
    });
    const isSecondaryPod = secondaryPeer != null;

    logger.warn(
      {
        localGeneration: state.generation,
        peerGeneration,
        lastKnownPeerGen: state.lastPeerGeneration,
        localRole: state.role,
        peerRole,
        isSecondaryPod,
      },
      isSecondaryPod
        ? "SPLIT-BRAIN DETECTED (secondary pod): divergence logged — NOT demoting to readonly; LWW will resolve at materialization"
        : "SPLIT-BRAIN DETECTED: Both pods advanced generation during partition"
    );

    // Secondary pods are never demoted: they are offline-capable local twins.
    // Primary / unset pods: the pod with fewer writes is demoted to readonly
    // (existing behavior, preserved for backward compatibility).
    const shouldDemoteSelf =
      !isSecondaryPod && state.generation <= peerGeneration;

    const newRole = shouldDemoteSelf ? "readonly" : state.role;

    await db
      .update(syncGeneration)
      .set({
        splitBrainDetected: true,
        splitBrainDetectedAt: new Date(),
        splitBrainLocalGen: state.generation,
        splitBrainRemoteGen: peerGeneration,
        role: newRole,
        lastPeerGeneration: peerGeneration,
        lastPeerContact: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(syncGeneration.id, "current"));

    invalidateSyncGenerationCache();

    if (isSecondaryPod) {
      logger.warn(
        { localGen: state.generation, peerGen: peerGeneration },
        "Secondary pod continues operating (offline-twin model); LWW resolves divergence"
      );
    } else if (shouldDemoteSelf) {
      logger.warn(
        { newRole, localGen: state.generation, peerGen: peerGeneration },
        "Pod demoted to read-only (fewer writes during partition)"
      );
    } else {
      logger.info(
        { localGen: state.generation, peerGen: peerGeneration },
        "Pod remains primary (more writes during partition)"
      );
    }

    return { splitBrain: true };
  }

  // Normal case: update peer info
  await db
    .update(syncGeneration)
    .set({
      lastPeerGeneration: peerGeneration,
      lastPeerContact: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(syncGeneration.id, "current"));

  invalidateSyncGenerationCache();
  return { splitBrain: false };
}

/**
 * Promote this pod to primary (admin action).
 * Clears split-brain flag and sets role to 'primary'.
 */
export async function promoteToPrimary(): Promise<void> {
  await db
    .update(syncGeneration)
    .set({
      role: "primary",
      splitBrainDetected: false,
      splitBrainDetectedAt: null,
      splitBrainLocalGen: null,
      splitBrainRemoteGen: null,
      promotedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(syncGeneration.id, "current"));

  invalidateSyncGenerationCache();
  logger.info("Pod promoted to primary — split-brain flag cleared");
}

/**
 * Get the full sync generation row for status endpoints.
 */
export async function getSyncGenerationRow(): Promise<{
  generation: number;
  role: string;
  splitBrainDetected: boolean;
  splitBrainDetectedAt: Date | null;
  splitBrainLocalGen: number | null;
  splitBrainRemoteGen: number | null;
  lastPeerGeneration: number;
  lastPeerContact: Date | null;
  promotedAt: Date | null;
  promotedFrom: string | null;
}> {
  const row = await db.query.syncGeneration.findFirst({
    where: eq(syncGeneration.id, "current"),
  });

  if (!row) {
    return {
      generation: 0,
      role: "primary",
      splitBrainDetected: false,
      splitBrainDetectedAt: null,
      splitBrainLocalGen: null,
      splitBrainRemoteGen: null,
      lastPeerGeneration: 0,
      lastPeerContact: null,
      promotedAt: null,
      promotedFrom: null,
    };
  }

  return {
    generation: row.generation,
    role: row.role,
    splitBrainDetected: row.splitBrainDetected,
    splitBrainDetectedAt: row.splitBrainDetectedAt,
    splitBrainLocalGen: row.splitBrainLocalGen,
    splitBrainRemoteGen: row.splitBrainRemoteGen,
    lastPeerGeneration: row.lastPeerGeneration ?? 0,
    lastPeerContact: row.lastPeerContact,
    promotedAt: row.promotedAt,
    promotedFrom: row.promotedFrom,
  };
}
