/**
 * Channel Gateway tRPC Router
 *
 * User-facing procedures for managing external channel connections
 * (Telegram, WhatsApp, etc.) that route messages to Synap AI.
 *
 * Endpoints:
 *   channelGateway.initLink   — generate a one-time link token to show in the app
 *   channelGateway.list       — list all connections for the current user
 *   channelGateway.unlink     — remove a connection
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { db, eq, and } from "@synap/database";
import { channelConnections, channelLinkTokens } from "@synap/database/schema";
import { randomBytes } from "crypto";

/** Generate a readable 20-character alphanumeric token (128-bit entropy) */
function generateLinkToken(): string {
  return randomBytes(16).toString("base64url").slice(0, 20).toUpperCase();
}

export const channelGatewayRouter = router({
  /**
   * Generate a one-time link token.
   * The user copies this token and sends it to the bot via /link <token>.
   */
  initLink: protectedProcedure
    .input(
      z.object({
        channel: z.enum(["telegram", "whatsapp", "discord"]),
        defaultChannelId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      const token = generateLinkToken();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      await db.insert(channelLinkTokens).values({
        token,
        channel: input.channel,
        userId,
        workspaceId: null,
        defaultChannelId: input.defaultChannelId ?? null,
        expiresAt,
      });

      return {
        token,
        expiresAt,
        instruction: `/link ${token}`,
      };
    }),

  /**
   * List all channel connections for the current user.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userId;

    const connections = await db.query.channelConnections.findMany({
      where: eq(channelConnections.userId, userId),
      columns: {
        id: true,
        channel: true,
        channelUserId: true,
        externalUsername: true,
        workspaceId: true,
        defaultChannelId: true,
        createdAt: true,
      },
    });

    return connections;
  }),

  /**
   * Remove a channel connection.
   */
  unlink: protectedProcedure
    .input(
      z.object({
        connectionId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      const connection = await db.query.channelConnections.findFirst({
        where: and(
          eq(channelConnections.id, input.connectionId),
          eq(channelConnections.userId, userId)
        ),
        columns: { id: true },
      });

      if (!connection) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Connection not found",
        });
      }

      await db
        .delete(channelConnections)
        .where(eq(channelConnections.id, input.connectionId));

      return { ok: true };
    }),
});
