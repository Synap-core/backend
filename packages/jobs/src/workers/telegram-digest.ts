/**
 * Telegram Morning Digest Worker
 *
 * Runs daily at 8:00 AM via pg-boss cron schedule.
 * For each user with a Telegram connection, builds a summary of:
 *   - Pending proposals awaiting review
 *   - New entities created in the last 24 hours
 * and sends it via Telegram bot message.
 */

import {
  db,
  eq,
  and,
  gte,
  channelConnections,
  proposals,
  entities,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { count } from "drizzle-orm";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "telegram-digest" });

/**
 * Send a Telegram bot message directly via the Bot API.
 *
 * The jobs package doesn't depend on @synap/api, so we resolve the bot
 * token from env (the simplest tier). In production the API-level
 * telegram-bot-token.ts handles the full 3-tier chain; the cron worker
 * only needs the env fallback since it runs in the same process.
 */
async function sendTelegramMessage(
  chatId: string,
  text: string,
  inlineKeyboard?: Array<Array<{ text: string; web_app?: { url: string } }>>
): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? null;

  if (!botToken) {
    logger.warn("No TELEGRAM_BOT_TOKEN env var — skipping digest send");
    return false;
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };

  if (inlineKeyboard) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }

  try {
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
        { chatId, status: response.status, errorText },
        "Telegram digest sendMessage failed"
      );
      return false;
    }

    return true;
  } catch (err) {
    logger.error({ err, chatId }, "Failed to send Telegram digest");
    return false;
  }
}

/**
 * Main handler: runs daily at 8:00 AM.
 * Iterates all users with Telegram connections and sends a morning digest.
 */
export async function handleTelegramDigest(): Promise<void> {
  logger.info("Starting Telegram morning digest");

  // Fetch all Telegram connections
  const connections = await db
    .select({
      userId: channelConnections.userId,
      chatId: channelConnections.channelUserId,
      workspaceId: channelConnections.workspaceId,
    })
    .from(channelConnections)
    .where(eq(channelConnections.channel, "telegram"));

  if (connections.length === 0) {
    logger.info("No Telegram connections found — skipping digest");
    return;
  }

  logger.info(
    { connectionCount: connections.length },
    "Processing Telegram digests"
  );

  const miniAppUrl =
    process.env.TELEGRAM_MINI_APP_URL || "https://app.synap.so";
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  let sentCount = 0;
  let skipCount = 0;

  for (const conn of connections) {
    try {
      // Count pending proposals for this user
      const [pendingResult] = await db
        .select({ value: count() })
        .from(proposals)
        .where(
          and(
            eq(proposals.createdBy, conn.userId),
            eq(proposals.status, ProposalStatus.PENDING),
            ...(conn.workspaceId
              ? [eq(proposals.workspaceId, conn.workspaceId)]
              : [])
          )
        );

      const pendingProposals = pendingResult?.value ?? 0;

      // Count new entities created in the last 24 hours
      // Scope to workspace if the connection has one
      const entityFilter = conn.workspaceId
        ? and(
            eq(entities.workspaceId, conn.workspaceId),
            gte(entities.createdAt, twentyFourHoursAgo)
          )
        : gte(entities.createdAt, twentyFourHoursAgo);

      const [entityResult] = await db
        .select({ value: count() })
        .from(entities)
        .where(entityFilter);

      const newEntities = entityResult?.value ?? 0;

      // Skip if there's nothing to report
      if (pendingProposals === 0 && newEntities === 0) {
        skipCount++;
        continue;
      }

      // Build the digest message
      const lines: string[] = [`*Good morning! Here's your Synap digest:*`, ``];

      if (pendingProposals > 0) {
        lines.push(
          `*${pendingProposals}* proposal${pendingProposals === 1 ? "" : "s"} awaiting your review`
        );
      }

      if (newEntities > 0) {
        lines.push(
          `*${newEntities}* new entit${newEntities === 1 ? "y" : "ies"} created in the last 24h`
        );
      }

      lines.push(``, `Open Synap to see the details.`);

      const message = lines.join("\n");

      const sent = await sendTelegramMessage(conn.chatId, message, [
        [
          {
            text: "Open Synap",
            web_app: { url: `${miniAppUrl}?startapp=digest` },
          },
        ],
      ]);

      if (sent) {
        sentCount++;
      }
    } catch (err) {
      logger.error(
        { err, userId: conn.userId },
        "Failed to process digest for user"
      );
    }
  }

  logger.info(
    { sent: sentCount, skipped: skipCount, total: connections.length },
    "Telegram morning digest complete"
  );
}
