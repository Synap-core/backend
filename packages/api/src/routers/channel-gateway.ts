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
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { db, eq, and, drizzleSql } from "@synap/database";
import {
  channelConnections,
  channelLinkTokens,
  workspaces,
} from "@synap/database/schema";
import { randomBytes } from "crypto";
import {
  clearTelegramTokenCache,
  clearTelegramSecretCache,
} from "../utils/telegram-bot-token.js";

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
   * Configure this pod's Telegram bot.
   * Validates the token, registers the webhook, and persists both to workspace settings.
   * After this, the bot starts receiving messages at /webhooks/telegram automatically.
   */
  setupTelegramBot: workspaceProcedure
    .input(
      z.object({
        botToken: z.string().min(10),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (process.env.TELEGRAM_BOT_ENABLED !== "true") {
        return {
          ok: false,
          enabled: false,
          message:
            "Telegram bot is disabled. Set TELEGRAM_BOT_ENABLED=true to enable, or use OpenClaw for Telegram integration.",
        };
      }

      const { botToken } = input;
      const workspaceId = ctx.workspaceId;

      // 1. Validate the token via Telegram's getMe endpoint
      const meRes = await fetch(
        `https://api.telegram.org/bot${botToken}/getMe`
      );
      const meData = (await meRes.json()) as {
        ok: boolean;
        result?: { username?: string; first_name?: string; id?: number };
        description?: string;
      };
      if (!meData.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            meData.description ?? "Invalid bot token — check with @BotFather",
        });
      }
      const botUsername = meData.result?.username ?? "bot";

      // 2. Generate a webhook secret (or reuse existing from workspace settings)
      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { settings: true },
      });
      const existingCp = (ws?.settings as Record<string, unknown> | null)
        ?.controlPlane as Record<string, unknown> | undefined;
      const webhookSecret =
        typeof existingCp?.telegramWebhookSecret === "string"
          ? existingCp.telegramWebhookSecret
          : randomBytes(32).toString("hex");

      // 3. Register the webhook with Telegram
      const podUrl = (
        process.env.PUBLIC_URL ??
        process.env.BACKEND_URL ??
        ""
      ).replace(/\/+$/, "");

      if (
        !podUrl ||
        podUrl.includes("localhost") ||
        podUrl.includes("127.0.0.1") ||
        podUrl.startsWith("http://")
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Webhook registration requires a public HTTPS pod URL. " +
            "Set PUBLIC_URL in your environment (e.g. https://pod.example.com). " +
            "Telegram does not accept localhost or plain HTTP URLs.",
        });
      }

      const webhookUrl = `${podUrl}/webhooks/telegram`;

      const whRes = await fetch(
        `https://api.telegram.org/bot${botToken}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: webhookSecret,
            allowed_updates: ["message", "callback_query"],
          }),
        }
      );
      const whData = (await whRes.json()) as {
        ok: boolean;
        description?: string;
      };
      if (!whData.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            whData.description ??
            "Failed to register webhook with Telegram. Make sure your pod URL is publicly accessible.",
        });
      }

      // 4. Save bot token + webhook secret to workspace settings (JSONB merge)
      const patch = {
        controlPlane: {
          ...(existingCp ?? {}),
          telegramBotToken: botToken,
          telegramWebhookSecret: webhookSecret,
          telegramBotUsername: `@${botUsername}`,
        },
      };
      await db
        .update(workspaces)
        .set({
          settings: drizzleSql`settings || ${JSON.stringify(patch)}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, workspaceId));

      // 5. Clear caches so next request picks up new values
      clearTelegramTokenCache();
      clearTelegramSecretCache();

      return {
        ok: true,
        botUsername: `@${botUsername}`,
        webhookUrl,
      };
    }),

  /**
   * Check Telegram bot configuration status for this workspace.
   * Returns whether a bot token is configured and the bot's username.
   */
  telegramStatus: workspaceProcedure.query(async ({ ctx }) => {
    if (process.env.TELEGRAM_BOT_ENABLED !== "true") {
      return {
        configured: false,
        botUsername: null,
        source: null,
        enabled: false,
        message:
          "Telegram bot is disabled. Set TELEGRAM_BOT_ENABLED=true to enable, or use OpenClaw for Telegram integration.",
      };
    }

    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, ctx.workspaceId),
      columns: { settings: true },
    });

    const cp = (ws?.settings as Record<string, unknown> | null)
      ?.controlPlane as Record<string, unknown> | undefined;

    const hasBotToken =
      typeof cp?.telegramBotToken === "string" &&
      (cp.telegramBotToken as string).length > 0;
    const botUsername =
      typeof cp?.telegramBotUsername === "string"
        ? (cp.telegramBotUsername as string)
        : null;
    const hasEnvToken = !!process.env.TELEGRAM_BOT_TOKEN;

    return {
      configured: hasBotToken || hasEnvToken,
      botUsername: botUsername ?? (hasEnvToken ? "@SynapBot" : null),
      source: hasBotToken
        ? ("workspace" as const)
        : hasEnvToken
          ? ("env" as const)
          : null,
    };
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
