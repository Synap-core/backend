/**
 * Sync Push Worker
 *
 * Cron job (every minute via pg-boss) that pushes completed events to registered push peers.
 *
 * For each enabled push peer:
 * 1. Read the last cursor from sync_state (or epoch if first sync)
 * 2. Query events WHERE timestamp > cursor AND type LIKE '%.completed' LIMIT 500
 * 3. POST batch to peer's /api/sync/receive endpoint
 * 4. On success: advance cursor + update stats
 * 5. On failure: increment errorCount; stop retrying after 10 consecutive failures
 * 6. Handle backpressure: if peer responds with { backpressure: true }, skip this cycle
 */

import {
  db,
  syncPeers,
  syncState,
  syncGeneration,
  events,
  eq,
  and,
  drizzleSql,
  advanceOutboundSyncCursorAfterPushSuccess,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "sync-push" });

/** Maximum consecutive errors before we stop retrying (requires manual reset) */
const MAX_ERROR_COUNT = 10;

/** Maximum events per batch sent to peer */
const BATCH_SIZE = 500;

/** HTTP timeout for sync requests (ms) */
const SYNC_TIMEOUT_MS = 30_000;

/** Source pod identifier (from env or fallback) */
const SOURCE_POD_ID =
  process.env.POD_ID || process.env.SYNAP_POD_ID || "unknown";

interface SyncReceiveResponse {
  received: boolean;
  processed: number;
  backpressure?: boolean;
  generation?: number;
  role?: string;
  splitBrain?: boolean;
}

// ─── Generation helpers (inline to avoid circular dep on @synap/api) ────────

/**
 * Increment local generation and return the current state.
 * Mirrors split-brain-service logic but avoids importing from @synap/api.
 */
async function incrementGenerationAndGetState(): Promise<{
  generation: number;
  role: string;
}> {
  // Ensure the row exists
  await db
    .insert(syncGeneration)
    .values({ id: "current", generation: 0, role: "primary" })
    .onConflictDoNothing();

  // Increment and return
  const [updated] = await db
    .update(syncGeneration)
    .set({
      generation: drizzleSql`${syncGeneration.generation} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(syncGeneration.id, "current"))
    .returning({
      generation: syncGeneration.generation,
      role: syncGeneration.role,
    });

  return updated ?? { generation: 0, role: "primary" };
}

/**
 * Record peer generation received in sync response.
 * Lightweight version — full split-brain detection runs in the API layer's
 * recordPeerGeneration() when the peer pushes to us. This just updates
 * the peer tracking fields so the API layer has fresh data.
 */
async function updatePeerGeneration(
  peerGeneration: number,
  _peerRole: string
): Promise<void> {
  if (peerGeneration <= 0) return;

  await db
    .update(syncGeneration)
    .set({
      lastPeerGeneration: peerGeneration,
      lastPeerContact: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(syncGeneration.id, "current"));
}

/**
 * Push events to a single peer. Returns the number of events sent, or -1 on error.
 */
async function pushToPeer(
  peer: {
    id: string;
    peerPodUrl: string;
    authToken: string | null;
    workspaceIds: string[] | null;
    direction: string;
  },
  generationState: { generation: number; role: string }
): Promise<void> {
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
    // Determine cursor: bidirectional peers use lastPushCursor, others use lastCursor
    const cursor =
      (peer.direction === "bidirectional"
        ? state.lastPushCursor
        : state.lastCursor) ?? new Date(0);

    // Build workspace filter conditions
    // Events store workspaceId in the JSONB `data` column, so we extract it with ->>
    const conditions = [
      drizzleSql`${events.timestamp} > ${cursor}`,
      drizzleSql`${events.type} LIKE '%.completed'`,
    ];

    if (peer.workspaceIds && peer.workspaceIds.length > 0) {
      // Filter to events whose data->>'workspaceId' matches one of the configured workspace IDs.
      // Events without a workspaceId in data (e.g. pod-level profiles) are included too,
      // since they're not workspace-scoped and should sync regardless.
      const wsPlaceholders = peer.workspaceIds
        .map((id) => `'${id.replace(/'/g, "''")}'`)
        .join(", ");
      conditions.push(
        drizzleSql`(${events.data}->>'workspaceId' IN (${drizzleSql.raw(wsPlaceholders)}) OR ${events.data}->>'workspaceId' IS NULL)`
      );
    }

    // Query completed events after cursor
    const batch = await db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(events.timestamp)
      .limit(BATCH_SIZE);

    if (batch.length === 0) {
      // Nothing to sync — mark idle
      await db
        .update(syncState)
        .set({ status: "idle", lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(syncState.id, state.id));
      return;
    }

    // Build payload
    const payload = {
      events: batch.map((evt) => ({
        id: evt.id,
        type: evt.type,
        subjectType: evt.subjectType,
        subjectId: evt.subjectId,
        data: evt.data,
        metadata: evt.metadata,
        source: evt.source,
        userId: evt.userId,
        timestamp:
          evt.timestamp instanceof Date
            ? evt.timestamp.toISOString()
            : String(evt.timestamp),
        correlationId: evt.correlationId ?? undefined,
      })),
      cursor:
        batch[batch.length - 1].timestamp instanceof Date
          ? batch[batch.length - 1].timestamp.toISOString()
          : String(batch[batch.length - 1].timestamp),
    };

    // POST to peer
    const url = `${peer.peerPodUrl.replace(/\/+$/, "")}/api/sync/receive`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Source-Pod-Id": SOURCE_POD_ID,
      "X-Sync-Generation": String(generationState.generation),
      "X-Sync-Role": generationState.role,
    };
    if (peer.authToken) {
      headers["Authorization"] = `Bearer ${peer.authToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      throw new Error(
        `Peer responded ${response.status}: ${errorText.slice(0, 200)}`
      );
    }

    const result = (await response.json()) as SyncReceiveResponse;

    // Handle backpressure
    if (result.backpressure) {
      logger.info(
        { peerId: peer.id },
        "Peer signalled backpressure — will retry next cycle"
      );
      await db
        .update(syncState)
        .set({ status: "idle", lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(syncState.id, state.id));
      return;
    }

    // Record peer generation from response (enables bidirectional split-brain detection)
    if (typeof result.generation === "number" && result.generation > 0) {
      await updatePeerGeneration(
        result.generation,
        typeof result.role === "string" ? result.role : "unknown"
      );
    }

    await advanceOutboundSyncCursorAfterPushSuccess({
      syncPeerId: peer.id,
      direction: peer.direction,
      cursorIso: payload.cursor,
      eventsSent: batch.length,
    });

    logger.info(
      { peerId: peer.id, eventsSent: batch.length, cursor: payload.cursor },
      "Sync push batch sent successfully"
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
      "Sync push failed"
    );
  }
}

/**
 * Main handler — called by pg-boss on the `sync-push` schedule (every minute).
 */
export async function handleSyncPush(): Promise<void> {
  try {
    // Fetch all enabled push or bidirectional peers
    const peers = await db.query.syncPeers.findMany({
      where: and(
        drizzleSql`${syncPeers.direction} IN ('push', 'bidirectional')`,
        eq(syncPeers.enabled, true)
      ),
    });

    if (peers.length === 0) {
      return; // No push peers configured — nothing to do
    }

    logger.debug({ peerCount: peers.length }, "Starting sync push cycle");

    // Increment generation once per push cycle (not per-peer, not per-event)
    const generationState = await incrementGenerationAndGetState();

    // Process each peer sequentially (avoid overwhelming outbound connections)
    for (const peer of peers) {
      try {
        await pushToPeer(peer, generationState);
      } catch (err) {
        // Catch-all so one peer failing doesn't block others
        logger.error(
          { peerId: peer.id, err },
          "Unexpected error pushing to sync peer"
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("relation") && msg.includes("does not exist")) {
      logger.debug("Sync push skipped — sync tables not yet migrated");
    } else {
      logger.error({ err }, "Sync push worker top-level error");
    }
  }
}

export const SYNC_PUSH_QUEUE = "sync-push";
