/**
 * Telegram Webhook Handler
 *
 * Receives Telegram Bot API updates (messages) and routes them:
 *   /link <token>  → consume link token, create channel_connections row
 *   /start         → welcome message with link instructions
 *   text messages   → forward to AI via persistent bot branch channel
 *
 * Security: verifies X-Telegram-Bot-Api-Secret-Token header.
 * Register with: POST https://api.telegram.org/bot{TOKEN}/setWebhook
 *   url: https://{pod-url}/webhooks/telegram
 *   secret_token: {TELEGRAM_WEBHOOK_SECRET}
 *   allowed_updates: ["message"]
 */

import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import {
  resolveTelegramBotToken,
  consumeLinkToken,
  forwardTelegramMessageToAI,
  findTelegramUser,
} from "@synap/api";

const logger = createLogger({ module: "telegram-webhook" });

export const telegramWebhookRouter = new Hono();

// ── Types ──────────────────────────────────────────────────────────────────

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function sendTelegramReply(
  chatId: string | number,
  text: string,
  botToken: string,
  parseMode: "Markdown" | "HTML" = "Markdown"
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    logger.error({ chatId, error: err }, "Failed to send Telegram reply");
  }
}

function displayName(from?: TelegramUser): string {
  if (!from) return "Unknown";
  const parts = [from.first_name, from.last_name].filter(Boolean);
  return parts.join(" ") || from.username || "Unknown";
}

// ── Webhook endpoint ───────────────────────────────────────────────────────

telegramWebhookRouter.post("/", async (c) => {
  // 1. Verify webhook secret
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    logger.warn("Telegram webhook: invalid secret token");
    return c.json({ ok: false }, 401);
  }

  // 2. Parse update
  let update: TelegramUpdate;
  try {
    update = await c.req.json<TelegramUpdate>();
  } catch {
    return c.json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const message = update.message;
  if (!message?.text || !message.chat) {
    // Skip non-text messages (photos, stickers, etc.) — return 200 so Telegram doesn't retry
    return c.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const senderName = displayName(message.from);

  // 3. Resolve bot token for replies
  const botToken = await resolveTelegramBotToken();
  if (!botToken) {
    logger.error("No Telegram bot token available — cannot reply");
    return c.json({ ok: true }); // Don't fail the webhook
  }

  // 4. Handle commands
  if (text.startsWith("/")) {
    const [cmd, ...args] = text.split(/\s+/);
    const command = cmd.toLowerCase();

    // /start — welcome message
    if (command === "/start") {
      await sendTelegramReply(
        chatId,
        "Welcome to Synap! Link your account with `/link <token>` (generate a token in Synap → Settings → Channels).\n\nOnce linked, just send me messages and I'll respond with AI.",
        botToken
      );
      return c.json({ ok: true });
    }

    // /link <token> — link account
    if (command === "/link") {
      const token = args[0];
      if (!token) {
        await sendTelegramReply(
          chatId,
          "Usage: `/link YOUR_TOKEN`\n\nGenerate a token in Synap → Settings → Channels → Telegram → Link.",
          botToken
        );
        return c.json({ ok: true });
      }

      const result = await consumeLinkToken(
        token,
        "telegram",
        chatId,
        message.from?.username ?? senderName
      );

      if (result.ok) {
        await sendTelegramReply(
          chatId,
          "Linked successfully! You can now send messages here and I'll respond with AI.",
          botToken
        );
      } else {
        await sendTelegramReply(
          chatId,
          `Link failed: ${result.error}`,
          botToken
        );
      }

      return c.json({ ok: true });
    }

    // /status — check link status
    if (command === "/status") {
      const connection = await findTelegramUser(chatId);
      if (connection) {
        await sendTelegramReply(
          chatId,
          `Linked to Synap${connection.workspaceId ? " (workspace connected)" : ""}.\nSend any message to chat with AI.`,
          botToken
        );
      } else {
        await sendTelegramReply(
          chatId,
          "Not linked. Use `/link <token>` to connect your Synap account.",
          botToken
        );
      }
      return c.json({ ok: true });
    }

    // Unknown command — ignore
    return c.json({ ok: true });
  }

  // 5. Forward message to AI
  // Send "typing" indicator while processing
  fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {}); // fire-and-forget

  const result = await forwardTelegramMessageToAI({
    telegramChatId: chatId,
    text,
    senderName,
  });

  if (result.ok && result.reply) {
    // Telegram has a 4096 char limit — split if needed
    const MAX_TG_LENGTH = 4096;
    if (result.reply.length <= MAX_TG_LENGTH) {
      await sendTelegramReply(chatId, result.reply, botToken);
    } else {
      // Split into chunks at line boundaries
      let remaining = result.reply;
      while (remaining.length > 0) {
        let chunk: string;
        if (remaining.length <= MAX_TG_LENGTH) {
          chunk = remaining;
          remaining = "";
        } else {
          const cutAt = remaining.lastIndexOf("\n", MAX_TG_LENGTH);
          const splitAt = cutAt > MAX_TG_LENGTH / 2 ? cutAt : MAX_TG_LENGTH;
          chunk = remaining.slice(0, splitAt);
          remaining = remaining.slice(splitAt).trimStart();
        }
        await sendTelegramReply(chatId, chunk, botToken);
      }
    }
  } else if (result.error) {
    await sendTelegramReply(chatId, result.error, botToken);
  }

  return c.json({ ok: true });
});

// Health check
telegramWebhookRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    webhook: "telegram",
    hasSecret: !!process.env.TELEGRAM_WEBHOOK_SECRET,
  });
});
