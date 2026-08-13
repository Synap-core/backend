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
import { protectedProcedure, workspaceProcedure } from "../../trpc.js";

import { TRPCError } from "@trpc/server";
import { db, eq, and } from "@synap/database";
import {
  channels,
  messages,
  ChannelType,
  ChannelStatus,
  MessageRole,
  mcpServers,
} from "@synap/database/schema";

import { randomUUID } from "crypto";
import { computeMessageHash } from "@synap/database";

import { listChannelsWithFlags } from "./helpers.js";

export const externalProcedures = {
  /**
   * List only external channels.
   */
  listExternalChannels: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const items = await listChannelsWithFlags({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        channelType: ChannelType.EXTERNAL,
        limit: input.limit + 1,
        offset: input.offset,
      });

      const hasMore = items.length > input.limit;
      const trimmed = hasMore ? items.slice(0, input.limit) : items;
      return {
        items: trimmed,
        pagination: {
          hasMore,
          limit: input.limit,
          offset: input.offset,
        },
      };
    }),

  /**
   * Add an MCP server to a channel's explicit opt-in list.
   * The server must be approved + enabled in the channel's workspace.
   */
  addMcpToChannel: protectedProcedure
    .input(
      z.object({ channelId: z.string().uuid(), mcpServerId: z.string().uuid() })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId)
        ),
      });
      if (!channel)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });

      // Verify the MCP server exists and is approved in the workspace
      if (channel.workspaceId) {
        const server = await db.query.mcpServers.findFirst({
          where: and(
            eq(mcpServers.id, input.mcpServerId),
            eq(mcpServers.workspaceId, channel.workspaceId),
            eq(mcpServers.approved, true),
            eq(mcpServers.enabled, true)
          ),
        });
        if (!server)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "MCP server not found or not approved",
          });
      }

      const currentIds = (channel.mcpServerIds as string[] | null) ?? [];
      if (currentIds.includes(input.mcpServerId))
        return { channelId: input.channelId };

      await db
        .update(channels)
        .set({
          mcpServerIds: [...currentIds, input.mcpServerId],
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.channelId));

      return { channelId: input.channelId };
    }),

  /**
   * Remove an MCP server from a channel's explicit opt-in list.
   */
  removeMcpFromChannel: protectedProcedure
    .input(
      z.object({ channelId: z.string().uuid(), mcpServerId: z.string().uuid() })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId)
        ),
      });
      if (!channel)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });

      const currentIds = (channel.mcpServerIds as string[] | null) ?? [];
      await db
        .update(channels)
        .set({
          mcpServerIds: currentIds.filter((id) => id !== input.mcpServerId),
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.channelId));

      return { channelId: input.channelId };
    }),

  /**
   * Create (or return existing) external import channel.
   * Used by the import orchestrator and proposal executor for external source channels.
   */
  createExternalChannel: workspaceProcedure
    .input(
      z.object({
        externalSource: z.string().max(100),
        externalChannelId: z.string().max(500),
        title: z.string().max(500),
        externalParticipants: z.array(z.string()).optional(),
        initialMessage: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Return existing channel if already imported
      const [existing] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, ctx.workspaceId),
            eq(channels.channelType, ChannelType.EXTERNAL),
            eq(channels.externalChannelId, input.externalChannelId)
          )
        )
        .limit(1);

      if (existing) {
        return { channelId: existing.id, status: "existing" as const };
      }

      const [channel] = await db
        .insert(channels)
        .values({
          id: randomUUID(),
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          channelType: ChannelType.EXTERNAL,
          title: input.title,
          externalSource: input.externalSource,
          externalChannelId: input.externalChannelId,
          metadata: {
            externalParticipants: input.externalParticipants ?? [],
            ...(input.metadata ?? {}),
          },
          status: ChannelStatus.ACTIVE,
        })
        .returning();

      if (input.initialMessage) {
        // Canonical tamper-hash: computeMessageHash(id, content) — the ONE
        // formula (see message-hash.ts). Generate the id up front so the stored
        // hash binds to the row's actual id.
        const messageId = randomUUID();
        await db.insert(messages).values({
          id: messageId,
          channelId: channel.id,
          content: input.initialMessage,
          role: MessageRole.USER,
          userId: ctx.userId,
          previousHash: "",
          hash: computeMessageHash(messageId, input.initialMessage),
        });
      }

      return { channelId: channel.id, status: "created" as const };
    }),
};
