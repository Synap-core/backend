/**
 * Telegram Webhook Handler
 *
 * Receives Telegram Bot API updates and routes them:
 *   /link <token>               → consume link token, create channel_connections row
 *   /start                      → welcome message with link instructions
 *   text messages               → forward to AI via persistent bot branch channel
 *   callback_query (inline btn) → proposal:approve:{id} / proposal:reject:{id}
 *
 * Security: verifies X-Telegram-Bot-Api-Secret-Token header.
 * Register with: POST https://api.telegram.org/bot{TOKEN}/setWebhook
 *   url: https://{pod-url}/webhooks/telegram
 *   secret_token: {TELEGRAM_WEBHOOK_SECRET}
 *   allowed_updates: ["message", "callback_query"]
 */

import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import {
  resolveTelegramBotToken,
  resolveTelegramWebhookSecret,
  consumeLinkToken,
  forwardTelegramMessageToAI,
  findTelegramUser,
  proposalsRouter,
} from "@synap/api";
import { db } from "@synap/database";

const logger = createLogger({ module: "telegram-webhook" });

export const telegramWebhookRouter = new Hono();

// ── Idempotency dedup (Telegram may retry on timeout) ──────────────────────
// Keyed by update_id, evicted after 10 minutes
const processedUpdates = new Map<number, number>(); // updateId → timestamp
const DEDUP_TTL_MS = 10 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [id, ts] of processedUpdates) {
    if (ts < cutoff) processedUpdates.delete(id);
  }
}, DEDUP_TTL_MS).unref();

// ── /link rate limit (max 10 attempts per chatId per 10 min) ───────────────
const linkAttempts = new Map<string, { count: number; resetAt: number }>();
function checkLinkRateLimit(chatId: string): boolean {
  const now = Date.now();
  const entry = linkAttempts.get(chatId);
  if (!entry || entry.resetAt < now) {
    linkAttempts.set(chatId, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}
setInterval(
  () => {
    const now = Date.now();
    for (const [id, entry] of linkAttempts) {
      if (entry.resetAt < now) linkAttempts.delete(id);
    }
  },
  10 * 60 * 1000
).unref();

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

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: { chat: { id: number } };
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
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

/** Answer a callback_query — required by Telegram to dismiss the loading spinner. */
async function answerCallbackQuery(
  callbackQueryId: string,
  botToken: string,
  text?: string,
  showAlert = false
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text,
      show_alert: showAlert,
    }),
  }).catch(() => {});
}

/**
 * Handle a proposal approve/reject callback_query.
 * callback_data format: "proposal:approve:{proposalId}" | "proposal:reject:{proposalId}"
 */
async function handleProposalCallback(
  callbackQueryId: string,
  callbackData: string,
  telegramChatId: string,
  botToken: string
): Promise<void> {
  const [, action, proposalId] = callbackData.split(":");
  if (!proposalId || (action !== "approve" && action !== "reject")) {
    await answerCallbackQuery(callbackQueryId, botToken, "Unknown action.");
    return;
  }

  // Look up the Synap user linked to this Telegram account
  const connection = await findTelegramUser(telegramChatId);
  if (!connection) {
    await answerCallbackQuery(
      callbackQueryId,
      botToken,
      "Your Telegram account is not linked to Synap. Send /link TOKEN to connect.",
      true
    );
    return;
  }

  // Build an internal caller context (userId is the Kratos identity ID)
  const callerCtx = {
    db,
    authenticated: true as const,
    userId: connection.userId,
    workspaceId: connection.workspaceId ?? undefined,
    workspaceRole: "admin" as const, // Telegram user is acting as themselves; authorization checked inside approve/reject
  };

  try {
    const caller = proposalsRouter.createCaller(callerCtx as any);

    if (action === "approve") {
      await caller.approve({ proposalId });
      await answerCallbackQuery(callbackQueryId, botToken, "✅ Approved!");
      await sendTelegramReply(
        telegramChatId,
        `✅ *Proposal approved.* The change has been applied.`,
        botToken
      );
    } else {
      await caller.reject({ proposalId });
      await answerCallbackQuery(callbackQueryId, botToken, "❌ Rejected.");
      await sendTelegramReply(
        telegramChatId,
        `❌ *Proposal rejected.*`,
        botToken
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Something went wrong";
    logger.error(
      { err, proposalId, action },
      "Failed to process proposal callback"
    );
    await answerCallbackQuery(callbackQueryId, botToken, message, true);
  }
}

// ── Webhook endpoint ───────────────────────────────────────────────────────

telegramWebhookRouter.post("/", async (c) => {
  // 1. Verify webhook secret (from workspace settings or env var)
  const secret = c.req.header("X-Telegram-Bot-Api-Secret-Token");
  const expectedSecret = await resolveTelegramWebhookSecret();

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

  // Idempotency: Telegram may retry the same update if we're slow to respond
  if (processedUpdates.has(update.update_id)) {
    return c.json({ ok: true }); // already handled
  }
  processedUpdates.set(update.update_id, Date.now());

  // ── callback_query (inline keyboard button press) ─────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = String(cq.message?.chat.id ?? cq.from.id);
    const data = cq.data ?? "";

    const botToken = await resolveTelegramBotToken();
    if (!botToken) {
      logger.error("No Telegram bot token — cannot answer callback_query");
      return c.json({ ok: true });
    }

    if (data.startsWith("proposal:")) {
      await handleProposalCallback(cq.id, data, chatId, botToken);
    } else {
      // Unknown callback — just dismiss the spinner
      await answerCallbackQuery(cq.id, botToken);
    }

    return c.json({ ok: true });
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
        "👋 *Welcome to Synap!*\n\nTo get started, link your account:\n1. Open Synap → Settings → Channels → Telegram\n2. Copy your link token\n3. Send `/link YOUR_TOKEN` here\n\nOnce linked, send me anything and I'll respond with AI.",
        botToken
      );
      return c.json({ ok: true });
    }

    // /help — list commands
    if (command === "/help") {
      await sendTelegramReply(
        chatId,
        "*Synap Bot Commands*\n\n`/start` — Welcome & setup guide\n`/link TOKEN` — Link your Synap account (token from Settings)\n`/status` — Check if your account is linked\n`/help` — Show this message\n\nOr just send any message to chat with your AI.",
        botToken
      );
      return c.json({ ok: true });
    }

    // /link <token> — link account
    if (command === "/link") {
      // Rate limit: max 10 attempts per chat per 10 minutes
      if (!checkLinkRateLimit(chatId)) {
        await sendTelegramReply(
          chatId,
          "Too many link attempts. Please wait a few minutes and try again.",
          botToken
        );
        return c.json({ ok: true });
      }

      const token = args[0];
      if (!token) {
        await sendTelegramReply(
          chatId,
          "Usage: `/link YOUR_TOKEN`\n\nGenerate a token in Synap → Settings → Channels → Telegram → Link.\n_Tokens expire after 15 minutes._",
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
          "✅ *Linked successfully!*\n\nYour Telegram account is now connected to Synap. Send me any message and I'll respond with AI.",
          botToken
        );
      } else {
        await sendTelegramReply(chatId, `❌ ${result.error}`, botToken);
      }

      return c.json({ ok: true });
    }

    // /status — check link status
    if (command === "/status") {
      const connection = await findTelegramUser(chatId);
      if (connection) {
        await sendTelegramReply(
          chatId,
          `✅ *Linked to Synap*${connection.workspaceId ? " (workspace connected)" : ""}.\n\nSend any message to chat with your AI.`,
          botToken
        );
      } else {
        await sendTelegramReply(
          chatId,
          "❌ *Not linked.* Use `/link <token>` to connect your Synap account.\n\nGenerate a token in Synap → Settings → Channels → Telegram.",
          botToken
        );
      }
      return c.json({ ok: true });
    }

    // Unknown command — suggest /help
    await sendTelegramReply(
      chatId,
      `Unknown command. Try \`/help\` to see available commands.`,
      botToken
    );
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

    // Send confirmation card if AI created proposals
    if (result.proposals && result.proposals.length > 0) {
      await sendConfirmationCard(chatId, result.proposals, botToken);
    }
  } else if (result.error) {
    await sendTelegramReply(chatId, result.error, botToken);
  }

  return c.json({ ok: true });
});

// ── Confirmation card ───────────────────────────────────────────────────────

const MINI_APP_URL =
  process.env.TELEGRAM_MINI_APP_URL ?? "https://app.synap.so";

async function sendConfirmationCard(
  chatId: string,
  proposals: Array<{
    proposalId: string;
    toolName: string;
    description: string;
  }>,
  botToken: string
): Promise<void> {
  const count = proposals.length;
  const summary =
    count === 1
      ? `📥 *1 item captured* — ${escapeMarkdown(proposals[0]!.description)}`
      : `📥 *${count} items captured*\n${proposals
          .map((p) => `• ${escapeMarkdown(p.description)}`)
          .join("\n")}`;

  // Deep link to proposals tab in the mini app
  const proposalsDeepLink = `${MINI_APP_URL}?startapp=proposals`;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: summary,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Review & confirm",
              web_app: { url: proposalsDeepLink },
            },
          ],
        ],
      },
    }),
  }).catch(() => {}); // fire-and-forget — don't fail the main response
}

/** Escape special Markdown v1 chars (Telegram subset). */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => `\\${c}`);
}

// Health check
telegramWebhookRouter.get("/health", async (c) => {
  const secret = await resolveTelegramWebhookSecret();
  return c.json({
    status: "ok",
    webhook: "telegram",
    hasSecret: !!secret,
    secretSource: process.env.TELEGRAM_WEBHOOK_SECRET
      ? "env"
      : secret
        ? "workspace_settings"
        : "none",
  });
});
