/**
 * Sync Management tRPC Router
 *
 * Admin-only routes for managing pod-to-pod sync peers and monitoring status.
 * Uses podAdminProcedure — only pod administrators can manage sync.
 */

import { z } from "zod";
import { router, podAdminProcedure } from "../trpc.js";
import {
  db,
  syncPeers,
  syncState,
  workspaces,
  eq,
  inArray,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { invalidateSyncPeerCache } from "../utils/sync-realtime-hook.js";

const logger = createLogger({ module: "sync-management" });

export const syncManagementRouter = router({
  /**
   * List all sync peers
   */
  listPeers: podAdminProcedure.query(async () => {
    const peers = await db.query.syncPeers.findMany({
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
    return peers;
  }),

  /**
   * Add a new sync peer
   */
  addPeer: podAdminProcedure
    .input(
      z.object({
        peerPodUrl: z.string().url(),
        direction: z.enum(["push", "pull"]),
        label: z.string().optional(),
        authToken: z.string().optional(),
        workspaceIds: z.array(z.string().uuid()).optional(),
        enabled: z.boolean().optional().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const [peer] = await db
        .insert(syncPeers)
        .values({
          peerPodUrl: input.peerPodUrl,
          direction: input.direction,
          label: input.label,
          authToken: input.authToken,
          workspaceIds: input.workspaceIds,
          enabled: input.enabled,
        })
        .returning();

      // Create initial sync_state row
      await db.insert(syncState).values({
        syncPeerId: peer.id,
      });

      logger.info(
        { peerId: peer.id, url: peer.peerPodUrl, direction: peer.direction },
        "Sync peer added"
      );

      invalidateSyncPeerCache();
      return peer;
    }),

  /**
   * Remove a sync peer (and its sync_state via CASCADE)
   */
  removePeer: podAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const existing = await db.query.syncPeers.findFirst({
        where: eq(syncPeers.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Sync peer not found",
        });
      }

      await db.delete(syncPeers).where(eq(syncPeers.id, input.id));

      logger.info({ peerId: input.id }, "Sync peer removed");
      invalidateSyncPeerCache();
      return { success: true };
    }),

  /**
   * Update a sync peer (enable/disable, change workspaceIds, label, etc.)
   *
   * workspaceIds accepts:
   * - string[] — sync only these workspaces
   * - null     — clear the filter (sync all workspaces)
   * - omitted  — leave unchanged
   */
  updatePeer: podAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        peerPodUrl: z.string().url().optional(),
        label: z.string().optional(),
        authToken: z.string().optional(),
        workspaceIds: z.array(z.string().uuid()).nullable().optional(),
        enabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...updates } = input;

      const existing = await db.query.syncPeers.findFirst({
        where: eq(syncPeers.id, id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Sync peer not found",
        });
      }

      // Build update set — only include fields that were provided
      const setValues: Record<string, unknown> = { updatedAt: new Date() };
      if (updates.peerPodUrl !== undefined)
        setValues.peerPodUrl = updates.peerPodUrl;
      if (updates.label !== undefined) setValues.label = updates.label;
      if (updates.authToken !== undefined)
        setValues.authToken = updates.authToken;
      if (updates.workspaceIds !== undefined)
        setValues.workspaceIds = updates.workspaceIds; // null clears filter, [] also clears (treated as "sync all")
      if (updates.enabled !== undefined) setValues.enabled = updates.enabled;

      const [updated] = await db
        .update(syncPeers)
        .set(setValues)
        .where(eq(syncPeers.id, id))
        .returning();

      logger.info({ peerId: id }, "Sync peer updated");
      return updated;
    }),

  /**
   * Get sync status for all peers (peers joined with their sync_state).
   * Includes resolved workspace names for peers with workspace filtering.
   */
  getStatus: podAdminProcedure.query(async () => {
    const peers = await db.query.syncPeers.findMany({
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    const states = await db.query.syncState.findMany();

    // Build a map of peerId → state
    const stateMap = new Map(states.map((s) => [s.syncPeerId, s]));

    // Collect all workspace IDs referenced by any peer for name resolution
    const allWorkspaceIds = new Set<string>();
    for (const peer of peers) {
      if (peer.workspaceIds && peer.workspaceIds.length > 0) {
        for (const wsId of peer.workspaceIds) {
          allWorkspaceIds.add(wsId);
        }
      }
    }

    // Resolve workspace names in a single query
    let workspaceNameMap = new Map<string, string>();
    if (allWorkspaceIds.size > 0) {
      const wsRows = await db
        .select({ id: workspaces.id, name: workspaces.name })
        .from(workspaces)
        .where(inArray(workspaces.id, [...allWorkspaceIds]));
      workspaceNameMap = new Map(wsRows.map((ws) => [ws.id, ws.name]));
    }

    return peers.map((peer) => ({
      ...peer,
      syncState: stateMap.get(peer.id) ?? null,
      /** Resolved workspace names for display (only present when workspaceIds is set) */
      workspaceNames:
        peer.workspaceIds && peer.workspaceIds.length > 0
          ? peer.workspaceIds.map(
              (id) => workspaceNameMap.get(id) ?? "Unknown Workspace"
            )
          : null,
    }));
  }),

  /**
   * Reset a peer's error state and optionally its cursor (force re-sync)
   */
  resetPeer: podAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        resetCursor: z.boolean().optional().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const state = await db.query.syncState.findFirst({
        where: eq(syncState.syncPeerId, input.id),
      });

      if (!state) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Sync state not found for this peer",
        });
      }

      const setValues: Record<string, unknown> = {
        status: "idle",
        errorCount: 0,
        lastError: null,
        updatedAt: new Date(),
      };

      if (input.resetCursor) {
        setValues.lastCursor = null;
        setValues.eventsProcessed = 0;
      }

      await db
        .update(syncState)
        .set(setValues)
        .where(eq(syncState.id, state.id));

      logger.info(
        { peerId: input.id, resetCursor: input.resetCursor },
        "Sync peer state reset"
      );

      return { success: true };
    }),
});
