/**
 * Sync Management tRPC Router
 *
 * Admin-only routes for managing pod-to-pod sync peers and monitoring status.
 * Uses podAdminProcedure — only pod administrators can manage sync.
 *
 * This is the OPERATOR-AUTHENTICATED path for peer registration. The CP-signed
 * REST endpoint (`POST /api/sync/setup-peer`) is the Control-Plane path. Both
 * call the same shared helper (`upsertSyncPeer`) to avoid logic duplication.
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
  and,
} from "@synap/database";
import { TRPCError } from "@trpc/server";
import { createLogger } from "@synap-core/core";
import { invalidateSyncPeerCache } from "../utils/sync-realtime-hook.js";
import {
  getSyncGenerationRow,
  promoteToPrimary,
} from "../utils/split-brain-service.js";

const logger = createLogger({ module: "sync-management" });

// ============================================================================
// Shared peer-upsert helper — used by both this tRPC router (operator auth)
// and the CP-signed REST endpoint (`POST /api/sync/setup-peer`).
// ============================================================================

export interface UpsertSyncPeerInput {
  peerPodUrl: string;
  // "inbound" = auth-only peer: authenticates the remote's inbound push/pull but
  // is NEVER picked up by this pod's outbound workers (used for an unreachable
  // peer such as the user's NAT'd local pod — the local pod drives sync).
  direction: "push" | "pull" | "bidirectional" | "inbound";
  authToken?: string | null;
  label?: string | null;
  workspaceIds?: string[] | null;
  localRole?: "primary" | "secondary" | "unset" | null;
  enabled?: boolean;
}

/**
 * Insert or update a sync peer row and ensure a matching `sync_state` row
 * exists. On conflict (same peerPodUrl + direction) the existing peer is
 * updated rather than duplicated — matching the CP setup-peer behavior.
 *
 * Returns the peer id.
 */
export async function upsertSyncPeer(
  input: UpsertSyncPeerInput
): Promise<string> {
  const existing = await db.query.syncPeers.findFirst({
    where: and(
      eq(syncPeers.peerPodUrl, input.peerPodUrl),
      eq(syncPeers.direction, input.direction)
    ),
  });

  if (existing) {
    await db
      .update(syncPeers)
      .set({
        authToken: input.authToken ?? existing.authToken,
        label: input.label !== undefined ? input.label : existing.label,
        workspaceIds:
          input.workspaceIds !== undefined
            ? input.workspaceIds
            : existing.workspaceIds,
        localRole:
          input.localRole !== undefined
            ? (input.localRole ?? "unset")
            : (existing.localRole ?? "unset"),
        enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
        updatedAt: new Date(),
      })
      .where(eq(syncPeers.id, existing.id));

    logger.info(
      {
        peerId: existing.id,
        peerUrl: input.peerPodUrl,
        direction: input.direction,
      },
      "Sync peer updated via upsertSyncPeer"
    );

    invalidateSyncPeerCache();
    return existing.id;
  }

  const [peer] = await db
    .insert(syncPeers)
    .values({
      peerPodUrl: input.peerPodUrl,
      direction: input.direction,
      authToken: input.authToken ?? null,
      label: input.label ?? null,
      workspaceIds: input.workspaceIds ?? null,
      localRole: input.localRole ?? "unset",
      enabled: input.enabled !== undefined ? input.enabled : true,
    })
    .returning();

  await db.insert(syncState).values({ syncPeerId: peer.id });

  logger.info(
    { peerId: peer.id, peerUrl: input.peerPodUrl, direction: input.direction },
    "Sync peer created via upsertSyncPeer"
  );

  invalidateSyncPeerCache();
  return peer.id;
}

// ============================================================================

export const syncManagementRouter = router({
  /**
   * List all sync peers
   */
  listPeers: podAdminProcedure.query(async () => {
    const peers = await db.query.syncPeers.findMany({
      orderBy: (t, { desc }) => [desc(t.createdAt)],
      // Exclude authToken from response — never expose secrets
      columns: {
        id: true,
        peerPodUrl: true,
        direction: true,
        enabled: true,
        label: true,
        workspaceIds: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return peers;
  }),

  /**
   * Add or update a sync peer (operator-authenticated path).
   *
   * Supports all three directions including "bidirectional" (for local-twin setup).
   * On duplicate (same peerPodUrl + direction) the existing peer is updated.
   * `localRole` controls split-brain demotion behavior:
   *   - "secondary" → pod is a local twin, never auto-demoted to readonly.
   *   - "primary"   → authority pod; current split-brain behavior.
   *   - "unset"     → legacy default (backward-compatible).
   */
  addPeer: podAdminProcedure
    .input(
      z.object({
        peerPodUrl: z.string().url(),
        direction: z.enum(["push", "pull", "bidirectional", "inbound"]),
        label: z.string().optional(),
        authToken: z.string().optional(),
        workspaceIds: z.array(z.string().uuid()).optional(),
        localRole: z
          .enum(["primary", "secondary", "unset"])
          .optional()
          .default("unset"),
        enabled: z.boolean().optional().default(true),
      })
    )
    .mutation(async ({ input }) => {
      const peerId = await upsertSyncPeer({
        peerPodUrl: input.peerPodUrl,
        direction: input.direction,
        authToken: input.authToken,
        label: input.label,
        workspaceIds: input.workspaceIds,
        localRole: input.localRole,
        enabled: input.enabled,
      });

      logger.info(
        {
          peerId,
          url: input.peerPodUrl,
          direction: input.direction,
          localRole: input.localRole,
        },
        "Sync peer added via operator tRPC"
      );

      return { peerId };
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
   * Update a sync peer (enable/disable, change workspaceIds, label, localRole, etc.)
   *
   * workspaceIds accepts:
   * - string[] — sync only these workspaces
   * - null     — clear the filter (sync all workspaces)
   * - omitted  — leave unchanged
   *
   * localRole: change the split-brain demotion behavior for this peer.
   */
  updatePeer: podAdminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        peerPodUrl: z.string().url().optional(),
        label: z.string().optional(),
        authToken: z.string().optional(),
        workspaceIds: z.array(z.string().uuid()).nullable().optional(),
        localRole: z.enum(["primary", "secondary", "unset"]).optional(),
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
      if (updates.localRole !== undefined)
        setValues.localRole = updates.localRole;
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

  /**
   * Get split-brain / generation status
   */
  getGenerationStatus: podAdminProcedure.query(async () => {
    const row = await getSyncGenerationRow();
    return {
      generation: row.generation,
      role: row.role,
      splitBrainDetected: row.splitBrainDetected,
      splitBrainDetectedAt: row.splitBrainDetectedAt?.toISOString() ?? null,
      splitBrainLocalGen: row.splitBrainLocalGen,
      splitBrainRemoteGen: row.splitBrainRemoteGen,
      lastPeerGeneration: row.lastPeerGeneration,
      lastPeerContact: row.lastPeerContact?.toISOString() ?? null,
      promotedAt: row.promotedAt?.toISOString() ?? null,
      promotedFrom: row.promotedFrom,
    };
  }),

  /**
   * Promote this pod to primary (clears split-brain flag).
   * Pod admin action — for cases where CP JWT is not available.
   */
  promote: podAdminProcedure.mutation(async () => {
    await promoteToPrimary();
    logger.info("Pod promoted to primary via tRPC admin action");
    const row = await getSyncGenerationRow();
    return {
      promoted: true,
      generation: row.generation,
      role: row.role,
      splitBrainDetected: row.splitBrainDetected,
    };
  }),
});
