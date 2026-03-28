/**
 * Sync Real-Time Hook
 *
 * Event repository hook #4: pushes .completed events to sync peers immediately
 * (sub-second), rather than waiting for the 60s polling cycle.
 *
 * Design:
 * - Fire-and-forget: failures are silent (the polling worker catches up)
 * - Peer list cached for 30s (avoids DB hit per event)
 * - Short bursts are batched (500ms debounce window)
 * - Backpressure: if a peer signals overload, pauses real-time for 60s
 * - Does NOT advance the sync cursor (polling worker owns that)
 *
 * The polling sync-push worker remains as the catch-up mechanism.
 */

import { db, syncPeers, eq } from "@synap/database";
import type { EventRecord } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "sync-realtime-hook" });

// ─── Peer Cache ──────────────────────────────────────────────────────────────

interface CachedPeer {
  id: string;
  peerPodUrl: string;
  authToken: string | null;
  workspaceIds: string[] | null;
}

let peerCache: CachedPeer[] = [];
let peerCacheAt = 0;
const PEER_CACHE_TTL_MS = 30_000;

async function getEnabledPushPeers(): Promise<CachedPeer[]> {
  const now = Date.now();
  if (now - peerCacheAt < PEER_CACHE_TTL_MS && peerCache.length > 0) {
    return peerCache;
  }

  try {
    const peers = await db
      .select({
        id: syncPeers.id,
        peerPodUrl: syncPeers.peerPodUrl,
        authToken: syncPeers.authToken,
        workspaceIds: syncPeers.workspaceIds,
      })
      .from(syncPeers)
      .where(
        // Push and bidirectional peers
        eq(syncPeers.enabled, true)
      );

    // Filter to push/bidirectional in JS (simpler than OR in drizzle)
    peerCache = peers.filter(
      (p) => p.peerPodUrl && p.peerPodUrl.startsWith("http")
    );
    peerCacheAt = now;
    return peerCache;
  } catch (err) {
    logger.warn({ err }, "Failed to refresh sync peer cache (non-fatal)");
    return peerCache; // stale cache is better than no cache
  }
}

/** Force-refresh peer cache (called when peers are added/removed) */
export function invalidateSyncPeerCache(): void {
  peerCacheAt = 0;
}

// ─── Backpressure Tracking ───────────────────────────────────────────────────

const backpressureUntil = new Map<string, number>(); // peerId → resumeAt timestamp
const BACKPRESSURE_PAUSE_MS = 60_000;

function isPeerBackpressured(peerId: string): boolean {
  const until = backpressureUntil.get(peerId);
  if (!until) return false;
  if (Date.now() > until) {
    backpressureUntil.delete(peerId);
    return false;
  }
  return true;
}

// ─── Event Batching ──────────────────────────────────────────────────────────

const pendingEvents: EventRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_WINDOW_MS = 500;
const MAX_BATCH_SIZE = 50;

function enqueuEvent(event: EventRecord): void {
  pendingEvents.push(event);

  // Flush immediately if batch is full
  if (pendingEvents.length >= MAX_BATCH_SIZE) {
    flushBatch();
    return;
  }

  // Otherwise debounce
  if (!flushTimer) {
    flushTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
  }
}

function flushBatch(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (pendingEvents.length === 0) return;

  // Drain the queue
  const batch = pendingEvents.splice(0);

  // Fire-and-forget — don't await
  pushBatchToPeers(batch).catch((err) => {
    logger.warn(
      { err, count: batch.length },
      "Sync real-time batch push failed (non-fatal)"
    );
  });
}

// ─── Push Logic ──────────────────────────────────────────────────────────────

const POST_TIMEOUT_MS = 5_000;

async function pushBatchToPeers(batch: EventRecord[]): Promise<void> {
  const peers = await getEnabledPushPeers();
  if (peers.length === 0) return;

  // Serialize events once (shared across peers)
  const serializedEvents = batch.map((e) => ({
    id: e.id,
    type: e.eventType,
    subjectType: e.subjectType,
    subjectId: e.subjectId,
    data: e.data,
    metadata: e.metadata,
    source: e.source,
    userId: e.userId,
    timestamp:
      e.timestamp instanceof Date
        ? e.timestamp.toISOString()
        : String(e.timestamp),
    correlationId: e.correlationId,
  }));

  const lastTimestamp =
    serializedEvents[serializedEvents.length - 1]?.timestamp;

  await Promise.allSettled(
    peers.map(async (peer) => {
      if (isPeerBackpressured(peer.id)) return;

      // Workspace filtering
      let eventsForPeer = serializedEvents;
      if (peer.workspaceIds && peer.workspaceIds.length > 0) {
        const wsSet = new Set(peer.workspaceIds);
        eventsForPeer = serializedEvents.filter((e) => {
          const wsId = (e.data as Record<string, unknown>)?.workspaceId;
          return !wsId || wsSet.has(String(wsId));
        });
        if (eventsForPeer.length === 0) return;
      }

      try {
        const res = await fetch(`${peer.peerPodUrl}/api/sync/receive`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(peer.authToken
              ? { Authorization: `Bearer ${peer.authToken}` }
              : {}),
            "X-Sync-Mode": "realtime",
          },
          body: JSON.stringify({
            events: eventsForPeer,
            cursor: lastTimestamp,
          }),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });

        if (res.ok) {
          const body = (await res.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          if (body.backpressure) {
            logger.info(
              { peerId: peer.id },
              "Peer signalled backpressure — pausing real-time for 60s"
            );
            backpressureUntil.set(peer.id, Date.now() + BACKPRESSURE_PAUSE_MS);
          }
        }
        // Non-200 is fine — polling will catch up
      } catch {
        // Network error — silent. Polling catches up.
      }
    })
  );
}

// ─── The Hook ────────────────────────────────────────────────────────────────

/**
 * Event repository hook that pushes .completed events to sync peers in real-time.
 * Register via `eventRepository.addEventHook(syncRealtimeHook)`.
 */
export function syncRealtimeHook(event: EventRecord): void {
  // Only sync completed events (same filter as the polling worker)
  if (!event.eventType.endsWith(".completed")) return;

  enqueuEvent(event);
}
