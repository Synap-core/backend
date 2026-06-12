/**
 * Sync Pull Worker
 *
 * Cron job (every minute via pg-boss) that pulls completed events from registered pull/bidirectional peers.
 *
 * For each enabled peer with direction "pull" or "bidirectional":
 * 1. Read the last pull cursor from sync_state (or epoch if first sync)
 * 2. GET {peerPodUrl}/api/sync/pull?since={lastPullCursor}&limit=500
 * 3. Materialize received events locally (with LWW conflict resolution)
 * 4. On success: advance pull cursor + update stats
 * 5. On failure: increment errorCount; stop retrying after 10 consecutive failures
 */

import {
  db,
  syncPeers,
  syncState,
  eq,
  and,
  drizzleSql,
  materializeBatch,
  type SyncEvent,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "sync-pull" });

/** Maximum consecutive errors before we stop retrying (requires manual reset) */
const MAX_ERROR_COUNT = 10;

/** Maximum events per pull batch */
const BATCH_SIZE = 500;

/**
 * Maximum batches consumed in a single tick during bootstrap mode.
 * Bootstrap = cursor is at (or near) epoch, meaning the local pod has never
 * synced before. We drain up to MAX_BOOTSTRAP_BATCHES × BATCH_SIZE = 25,000
 * events in one scheduler tick to minimise the time-to-mirror on first pair.
 * Steady-state (cursor is recent) stops after 1 batch as before.
 */
const MAX_BOOTSTRAP_BATCHES = 50;

/**
 * A cursor is considered "at epoch" (i.e. bootstrap mode) when it falls before
 * this threshold. We use 2000-01-01 as the sentinel — any real data post-dates
 * this, and new(0) (Unix epoch 1970) is comfortably before it.
 */
const BOOTSTRAP_EPOCH_THRESHOLD = new Date("2000-01-01T00:00:00Z");

/** HTTP timeout for sync requests (ms) */
const SYNC_TIMEOUT_MS = 30_000;

interface SyncPullResponse {
  events: SyncEvent[];
  cursor: string | null;
  hasMore: boolean;
}

/**
 * Pull events from a single peer. Materializes them locally with conflict resolution.
 */
async function pullFromPeer(peer: {
  id: string;
  peerPodUrl: string;
  authToken: string | null;
  direction: string;
}): Promise<void> {
  // Ensure sync_state row exists for this peer (upsert)
  let state = await db.query.syncState.findFirst({
    where: eq(syncState.syncPeerId, peer.id),
  });

  if (!state) {
    const [inserted] = await db
      .insert(syncState)
      .values({ syncPeerId: peer.id })
      .returning();
    state = inserted;
  }

  // If error count exceeded, don't retry
  if (state.errorCount >= MAX_ERROR_COUNT) {
    logger.warn(
      { peerId: peer.id, errorCount: state.errorCount },
      "Sync peer exceeded max errors — skipping until manual reset"
    );
    return;
  }

  // Mark as syncing
  await db
    .update(syncState)
    .set({ status: "syncing", updatedAt: new Date() })
    .where(eq(syncState.id, state.id));

  try {
    // Determine cursor: bidirectional peers use lastPullCursor, pure pull peers use lastCursor
    let cursor =
      (peer.direction === "bidirectional"
        ? state.lastPullCursor
        : state.lastCursor) ?? new Date(0);

    // Bootstrap mode: cursor is at or near epoch, meaning first-ever sync.
    // We drain up to MAX_BOOTSTRAP_BATCHES batches in one tick to minimise
    // time-to-mirror. Steady-state exits after the first batch (hasMore=false
    // or cursor is recent).
    const isBootstrap = cursor <= BOOTSTRAP_EPOCH_THRESHOLD;
    const maxBatches = isBootstrap ? MAX_BOOTSTRAP_BATCHES : 1;

    const baseUrl = peer.peerPodUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {};
    if (peer.authToken) {
      headers["Authorization"] = `Bearer ${peer.authToken}`;
    }

    let totalEventsPulled = 0;
    let totalMaterialized = 0;
    let totalConflicts = 0;
    let batchesConsumed = 0;
    let lastCursorValue: string | null = null;
    let nothingToPull = false;

    for (let batch = 0; batch < maxBatches; batch++) {
      const url = `${baseUrl}/api/sync/pull?since=${cursor.toISOString()}&limit=${BATCH_SIZE}`;

      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        throw new Error(
          `Peer responded ${response.status}: ${errorText.slice(0, 200)}`
        );
      }

      const result = (await response.json()) as SyncPullResponse;

      if (!result.events || result.events.length === 0) {
        nothingToPull = batch === 0; // only truly "nothing" on the very first fetch
        break;
      }

      // Materialize events with conflict resolution
      const batchResult = await materializeBatch(result.events, {
        syncPeerId: peer.id,
        checkConflicts: true,
      });

      totalEventsPulled += result.events.length;
      totalMaterialized += batchResult.materialized;
      totalConflicts += batchResult.conflicts;
      batchesConsumed++;
      lastCursorValue = result.cursor;

      // Advance cursor in DB after each batch so progress is never lost
      // even if we abort mid-loop on error.
      const newCursor = result.cursor ? new Date(result.cursor) : null;
      const cursorUpdate =
        peer.direction === "bidirectional"
          ? { lastPullCursor: newCursor }
          : { lastCursor: newCursor };

      await db
        .update(syncState)
        .set({
          ...cursorUpdate,
          lastSyncAt: new Date(),
          eventsProcessed: state.eventsProcessed + totalEventsPulled,
          updatedAt: new Date(),
        })
        .where(eq(syncState.id, state.id));

      if (newCursor) {
        cursor = newCursor;
      }

      // Exit loop if there's nothing more to fetch
      if (!result.hasMore) {
        break;
      }
    }

    if (nothingToPull) {
      // Nothing to pull — mark idle
      await db
        .update(syncState)
        .set({ status: "idle", lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(syncState.id, state.id));
      return;
    }

    // Final status update
    await db
      .update(syncState)
      .set({
        status: "idle",
        errorCount: 0,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(syncState.id, state.id));

    logger.info(
      {
        peerId: peer.id,
        eventsPulled: totalEventsPulled,
        materialized: totalMaterialized,
        conflicts: totalConflicts,
        batchesConsumed,
        cursor: lastCursorValue,
        bootstrapMode: isBootstrap,
      },
      "Sync pull cycle completed"
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const newErrorCount = state.errorCount + 1;

    await db
      .update(syncState)
      .set({
        status: newErrorCount >= MAX_ERROR_COUNT ? "error" : "idle",
        errorCount: newErrorCount,
        lastError: errorMessage.slice(0, 1000),
        lastSyncAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(syncState.id, state.id));

    logger.error(
      { peerId: peer.id, errorCount: newErrorCount, error: errorMessage },
      "Sync pull failed"
    );
  }
}

/**
 * Main handler — called by pg-boss on the `sync-pull` schedule (every minute).
 */
export async function handleSyncPull(): Promise<void> {
  try {
    // Fetch all enabled pull or bidirectional peers
    const peers = await db.query.syncPeers.findMany({
      where: and(
        drizzleSql`${syncPeers.direction} IN ('pull', 'bidirectional')`,
        eq(syncPeers.enabled, true)
      ),
    });

    if (peers.length === 0) {
      return; // No pull peers configured — nothing to do
    }

    logger.debug({ peerCount: peers.length }, "Starting sync pull cycle");

    // Process each peer sequentially (avoid overwhelming inbound connections)
    for (const peer of peers) {
      try {
        await pullFromPeer(peer);
      } catch (err) {
        // Catch-all so one peer failing doesn't block others
        logger.error(
          { peerId: peer.id, err },
          "Unexpected error pulling from sync peer"
        );
      }
    }
  } catch (err) {
    // sync_peers table may not exist yet (migration not run) — suppress to avoid log spam
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("relation") && msg.includes("does not exist")) {
      logger.debug("Sync pull skipped — sync tables not yet migrated");
    } else {
      logger.error({ err }, "Sync pull worker top-level error");
    }
  }
}

export const SYNC_PULL_QUEUE = "sync-pull";
