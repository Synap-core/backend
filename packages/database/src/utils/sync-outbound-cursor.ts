/**
 * Shared outbound sync cursor advancement after a successful push to a peer
 * (polling sync-push worker or realtime hook). Keeps sync_state consistent
 * with last delivered event timestamps.
 */

import { eq } from "drizzle-orm";
import { db } from "../client-pg.js";
import { syncState, type SyncState } from "../schema/sync.js";

export interface AdvanceOutboundSyncCursorParams {
  syncPeerId: string;
  /** From sync_peers.direction — only push/bidirectional advance outbound cursors */
  direction: string;
  /** ISO timestamp of the last event in the delivered batch */
  cursorIso: string;
  eventsSent: number;
}

/**
 * Advance lastCursor (push) or lastPushCursor (bidirectional) after events
 * were successfully accepted by the remote peer. Creates sync_state if missing.
 */
export async function advanceOutboundSyncCursorAfterPushSuccess(
  params: AdvanceOutboundSyncCursorParams
): Promise<SyncState> {
  const { syncPeerId, direction, cursorIso, eventsSent } = params;

  if (direction !== "push" && direction !== "bidirectional") {
    throw new Error(
      `advanceOutboundSyncCursorAfterPushSuccess: invalid direction ${direction}`
    );
  }

  const newCursor = new Date(cursorIso);

  let state = await db.query.syncState.findFirst({
    where: eq(syncState.syncPeerId, syncPeerId),
  });

  if (!state) {
    const [inserted] = await db
      .insert(syncState)
      .values({ syncPeerId })
      .returning();
    state = inserted;
  }

  const cursorUpdate =
    direction === "bidirectional"
      ? { lastPushCursor: newCursor }
      : { lastCursor: newCursor };

  const [updated] = await db
    .update(syncState)
    .set({
      ...cursorUpdate,
      lastSyncAt: new Date(),
      status: "idle",
      errorCount: 0,
      lastError: null,
      eventsProcessed: state.eventsProcessed + eventsSent,
      updatedAt: new Date(),
    })
    .where(eq(syncState.id, state.id))
    .returning();

  return updated ?? state;
}
