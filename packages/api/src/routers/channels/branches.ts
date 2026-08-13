/**
 * Channels Router - tRPC routes for channels (conversations) with branching
 *
 * Handles:
 * - Channel management (channels table, was chat_threads)
 * - Message sending/receiving with Intelligence Hub
 * - Entity extraction
 * - Branching logic
 * - Context tracking via channel_context_items
 */

import { z } from "zod";
import { protectedProcedure } from "../../trpc.js";
import { AccessContext, scopedDb } from "../../access/index.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";

import { channelVisibilityWhere } from "../../utils/channel-visibility.js";

import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  desc,
  and,
  or,
  inArray,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  channels,
  messages,
  ChannelType,
  ChannelStatus,
  proposals,
  ProposalStatus,
} from "@synap/database/schema";

import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";

import type { Channel } from "@synap/database/schema";

import { BranchNodeResult, buildBranchTree } from "./helpers.js";

export const branchesProcedures = {
  /**
   * Get branch channels for a parent channel
   */
  getBranches: protectedProcedure
    .input(
      z.object({
        parentChannelId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Canonical channel visibility — workspace members can see branches of
      // shared channels (GROUP/AGENT_COLLAB/EXTERNAL) they don't own.
      const branches = await db.query.channels.findMany({
        where: and(
          eq(channels.parentChannelId, input.parentChannelId),
          channelVisibilityWhere(ctx.userId)
        ),
        orderBy: [desc(channels.createdAt)],
      });

      return { branches };
    }),

  /**
   * Get all branch trees for a workspace — returns all root channels with their
   * children recursively, plus pending proposal counts per channel.
   */
  getWorkspaceBranchTree: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      // scopedDb auto-ANDs the membership predicate — a non-member passing a
      // foreign workspaceId gets an empty tree instead of leaking its channels.
      //
      // CAP: hard limit of 500 most-recently-active channels. Without it this
      // loaded every channel in the workspace and the tree build below is
      // O(n²) (each node re-filters allChannels for its children). 500 is well
      // above any realistic branch-tree size; if a workspace ever exceeds it,
      // the oldest channels fall off the tree rather than the query starving
      // the pool / blocking the event loop. Bump CHANNEL_TREE_CAP or move to
      // cursor pagination if real workspaces approach the cap.
      const CHANNEL_TREE_CAP = 500;
      const allChannels = await scopedDb(AccessContext.from(ctx)).findMany<
        typeof channels.$inferSelect
      >(channels, {
        where: eq(channels.workspaceId, input.workspaceId),
        orderBy: [desc(channels.updatedAt)],
        limit: CHANNEL_TREE_CAP,
      });

      if (allChannels.length === 0) {
        return {
          roots: [],
          stats: {
            totalChannels: 0,
            activeChannels: 0,
            pendingProposalsTotal: 0,
          },
          proposalCounts: {},
        };
      }

      const channelIds = allChannels.map((c) => c.id);

      // Count messages per channel (excluding ephemeral — they vanish on reload,
      // so they must not inflate a persisted per-channel activity count).
      const messageCounts = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(
          and(
            inArray(messages.channelId, channelIds),
            eq(messages.ephemeral, false)
          )
        );
      const messageCountMap: Record<string, number> = {};
      for (const row of messageCounts) {
        if (row.channelId) {
          messageCountMap[row.channelId] =
            (messageCountMap[row.channelId] || 0) + 1;
        }
      }

      // Count pending proposals per channel
      const pendingProposalRows = await db
        .select({
          threadId: proposals.threadId,
          count: drizzleSql<number>`count(*)::int`,
        })
        .from(proposals)
        .where(
          and(
            eq(proposals.workspaceId, input.workspaceId),
            eq(proposals.status, ProposalStatus.PENDING),
            inArray(proposals.threadId, channelIds)
          )
        )
        .groupBy(proposals.threadId);
      const proposalCounts: Record<string, number> = {};
      let pendingProposalsTotal = 0;
      for (const row of pendingProposalRows) {
        if (row.threadId) {
          proposalCounts[row.threadId] = row.count;
          pendingProposalsTotal += row.count;
        }
      }

      // Build channel map for O(1) child lookup
      const channelMap = new Map(allChannels.map((c) => [c.id, c]));

      function buildNode(channel: Channel, depth: number): BranchNodeResult {
        const children = allChannels
          .filter((c) => c.parentChannelId === channel.id)
          .map((child) => buildNode(child, depth + 1));
        return {
          channel,
          children,
          messageCount: messageCountMap[channel.id] || 0,
          lastActivity: channel.updatedAt,
          depth,
        };
      }

      // Root = no parentChannelId, or parent belongs to a different workspace
      const roots = allChannels
        .filter((c) => !c.parentChannelId || !channelMap.has(c.parentChannelId))
        .map((c) => buildNode(c, 0));

      const activeChannels = allChannels.filter(
        (c) => c.status === "active"
      ).length;

      return {
        roots,
        stats: {
          totalChannels: allChannels.length,
          activeChannels: activeChannels,
          pendingProposalsTotal,
        },
        proposalCounts,
      };
    }),

  /**
   * Merge branch channel into its parent
   */
  mergeBranch: protectedProcedure
    .input(
      z.object({
        branchId: z.string().uuid(),
        summary: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const branch = await db.query.channels.findFirst({
        where: eq(channels.id, input.branchId),
      });

      if (!branch || branch.channelType !== ChannelType.SUB_THREAD) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Branch not found" });
      }

      if (!branch.parentChannelId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Branch has no parent channel",
        });
      }

      // Gate on the branch's workspace/owner — without it any user could merge
      // another user's thread by id.
      await assertWorkspaceWrite(db, ctx.userId, {
        workspaceId: branch.workspaceId,
        ownerId: branch.userId,
      });

      await db
        .update(channels)
        .set({
          status: ChannelStatus.MERGED,
          mergedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.branchId));

      emitChatEvent({
        event: "channel:merged",
        data: {
          channelId: input.branchId,
          parentChannelId: branch.parentChannelId,
          userId: ctx.userId,
        },
        workspaceId: branch.workspaceId ?? ctx.workspaceId ?? null,
        userId: ctx.userId,
      });

      return {
        status: "merged",
        message: "Branch merged",
      };
    }),

  /**
   * Delete a branch that has no messages (sent when user navigates away without chatting).
   * Safe to call even if the branch has messages — it's a no-op in that case.
   * Only deletes branch-type channels owned by the caller.
   */
  pruneEmptyBranch: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId),
          eq(channels.channelType, ChannelType.THREAD),
          eq(channels.channelType, ChannelType.SUB_THREAD)
        ),
      });
      if (!channel) return { pruned: false };

      // Count non-deleted, non-ephemeral user/assistant messages. A branch that
      // only ever held ephemeral (live-only) messages is empty on reload, so it
      // is safe to prune.
      const msgs = await db.query.messages.findMany({
        where: and(
          eq(messages.channelId, input.channelId),
          isNull(messages.deletedAt),
          eq(messages.ephemeral, false)
        ),
        columns: { id: true },
        limit: 1,
      });
      if (msgs.length > 0) return { pruned: false };

      // Hard-delete the empty branch
      await db.delete(channels).where(eq(channels.id, input.channelId));
      return { pruned: true };
    }),

  /**
   * Get branch tree structure (not flat list)
   */
  getBranchTree: protectedProcedure
    .input(
      z.object({
        rootChannelId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Canonical channel visibility — workspace members can see branches of
      // shared channels (GROUP/AGENT_COLLAB/EXTERNAL) they don't own.
      const allChannels = await db.query.channels.findMany({
        where: and(
          or(
            eq(channels.id, input.rootChannelId),
            eq(channels.parentChannelId, input.rootChannelId)
          ),
          channelVisibilityWhere(ctx.userId)
        ),
      });

      const tree = buildBranchTree(allChannels, input.rootChannelId);

      const activeBranches = allChannels.filter(
        (c) => c.status === "active" && c.channelType === ChannelType.SUB_THREAD
      );
      const mergedBranches = allChannels.filter(
        (c) => c.status === "merged" && c.channelType === ChannelType.SUB_THREAD
      );

      return {
        tree,
        flatBranches: allChannels.filter(
          (c) => c.channelType === ChannelType.SUB_THREAD
        ),
        activeBranches,
        mergedBranches,
      };
    }),
};
