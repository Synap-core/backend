/**
 * Telegram Push Notifications
 *
 * Sends Telegram bot messages to users who have linked their account
 * via channel_connections. Used for proposal notifications, digests, etc.
 *
 * Resolution chain for bot token: vault → workspace settings → env
 * (delegated to telegram-bot-token.ts)
 */

import { db, eq, and, channelConnections } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { resolveTelegramBotToken } from "./telegram-bot-token.js";

const logger = createLogger({ module: "telegram-notify" });

export interface TelegramNotifyOptions {
  /** Markdown parse mode (default: "Markdown") */
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  /** Inline keyboard buttons */
  inlineKeyboard?: Array<
    Array<{
      text: string;
      url?: string;
      web_app?: { url: string };
      callback_data?: string;
    }>
  >;
  /** If true, disables link previews */
  disableWebPagePreview?: boolean;
}

/**
 * Send a Telegram bot message to a Synap user.
 *
 * Looks up channel_connections WHERE userId AND channel='telegram'.
 * If found, sends a message via the Telegram Bot API.
 *
 * Returns true if the message was sent, false if no connection found or send failed.
 */
export async function notifyTelegramUser(
  userId: string,
  message: string,
  options?: TelegramNotifyOptions
): Promise<boolean> {
  try {
    // Look up the user's Telegram connection
    const [connection] = await db
      .select({
        channelUserId: channelConnections.channelUserId,
      })
      .from(channelConnections)
      .where(
        and(
          eq(channelConnections.userId, userId),
          eq(channelConnections.channel, "telegram")
        )
      )
      .limit(1);

    if (!connection) {
      logger.debug({ userId }, "No Telegram connection found for user");
      return false;
    }

    // Resolve bot token via 3-tier chain
    const botToken = await resolveTelegramBotToken();
    if (!botToken) {
      logger.warn("Cannot send Telegram notification — no bot token available");
      return false;
    }

    // Build request body
    const body: Record<string, unknown> = {
      chat_id: connection.channelUserId,
      text: message,
      parse_mode: options?.parseMode ?? "Markdown",
    };

    if (options?.disableWebPagePreview) {
      body.disable_web_page_preview = true;
    }

    if (options?.inlineKeyboard) {
      body.reply_markup = {
        inline_keyboard: options.inlineKeyboard,
      };
    }

    // Send via Telegram Bot API
    const response = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      logger.warn(
        {
          userId,
          chatId: connection.channelUserId,
          status: response.status,
          errorText,
        },
        "Telegram sendMessage failed"
      );
      return false;
    }

    logger.info(
      { userId, chatId: connection.channelUserId },
      "Telegram notification sent"
    );
    return true;
  } catch (err) {
    logger.error({ err, userId }, "Failed to send Telegram notification");
    return false;
  }
}

/**
 * Send a proposal notification to a user via Telegram.
 *
 * Builds a formatted message with an inline keyboard button
 * that opens the proposal in the Synap Mini App.
 */
export async function notifyProposalViaTelegram(opts: {
  userId: string;
  proposalId: string;
  targetType: string;
  action: string;
  reasoning?: string;
  workspaceId?: string;
}): Promise<boolean> {
  const {
    userId,
    proposalId,
    targetType,
    action,
    reasoning,
    workspaceId: _ws,
  } = opts;

  const miniAppUrl =
    process.env.TELEGRAM_MINI_APP_URL || "https://app.synap.so";

  // Build a human-readable message
  const lines = [
    `*New Proposal Awaiting Review*`,
    ``,
    `Type: \`${targetType}.${action}\``,
  ];

  if (reasoning) {
    lines.push(`Reason: ${reasoning}`);
  }

  lines.push(``, `Tap below to review in Synap.`);

  const message = lines.join("\n");

  const deepLink = `${miniAppUrl}?startapp=proposal_${proposalId}`;

  return notifyTelegramUser(userId, message, {
    inlineKeyboard: [
      // Row 1: inline Approve / Reject buttons (handled by callback_query)
      [
        {
          text: "✅ Approve",
          callback_data: `proposal:approve:${proposalId}`,
        },
        {
          text: "❌ Reject",
          callback_data: `proposal:reject:${proposalId}`,
        },
      ],
      // Row 2: deep-link into the Mini App for full review
      [
        {
          text: "📱 Open in Synap",
          web_app: { url: deepLink },
        },
      ],
    ],
  });
}
