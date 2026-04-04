/**
 * Webhooks Main Router
 *
 * Aggregates all webhook routes (N8N, Intelligence Services, etc.)
 */
console.log("🔍 DEBUG: Loading apps/api/src/webhooks/index.ts");

import { Hono } from "hono";
import { n8nWebhookRouter } from "./n8n.js";
import { intelligenceWebhookRouter } from "./intelligence.js";
import { kratosWebhookRouter } from "./kratos.js";
import { telegramWebhookRouter } from "./telegram.js";

export const webhookRouter = new Hono();

// Mount webhook routes
webhookRouter.route("/n8n", n8nWebhookRouter);
webhookRouter.route("/kratos", kratosWebhookRouter);
webhookRouter.route("/intelligence", intelligenceWebhookRouter);

// Telegram webhook — only mounted when TELEGRAM_BOT_ENABLED=true
if (process.env.TELEGRAM_BOT_ENABLED === "true") {
  webhookRouter.route("/telegram", telegramWebhookRouter);
}

// Global webhook health check
webhookRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    routes: {
      n8n: "/webhooks/n8n/*",
      intelligence: "/webhooks/intelligence/*",
      telegram: "/webhooks/telegram/*",
    },
  });
});
