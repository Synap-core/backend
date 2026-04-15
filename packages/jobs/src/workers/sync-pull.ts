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
    const cursor =
      (peer.direction === "bidirectional"
        ? state.lastPullCursor
        : state.lastCursor) ?? new Date(0);

    // Build URL
    const baseUrl = peer.peerPodUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/api/sync/pull?since=${cursor.toISOString()}&limit=${BATCH_SIZE}`;

    const headers: Record<string, string> = {};
    if (peer.authToken) {
      headers["Authorization"] = `Bearer ${peer.authToken}`;
    }

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
      // Nothing to pull — mark idle
      await db
        .update(syncState)
        .set({ status: "idle", lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(syncState.id, state.id));
      return;
    }

    // Materialize events with conflict resolution
    const batchResult = await materializeBatch(result.events, {
      syncPeerId: peer.id,
      checkConflicts: true,
    });

    // Advance cursor
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
        status: "idle",
        errorCount: 0,
        lastError: null,
        eventsProcessed: state.eventsProcessed + result.events.length,
        updatedAt: new Date(),
      })
      .where(eq(syncState.id, state.id));

    logger.info(
      {
        peerId: peer.id,
        eventsPulled: result.events.length,
        materialized: batchResult.materialized,
        conflicts: batchResult.conflicts,
        cursor: result.cursor,
        hasMore: result.hasMore,
      },
      "Sync pull batch processed"
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
