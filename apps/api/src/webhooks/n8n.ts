/**
 * Webhook Routes - N8N Integration
 *
 * Handles incoming webhooks from N8N for inbox item ingestion.
 * Uses webhook secret authentication instead of user auth.
 */

import { timingSafeEqual } from "crypto";
import { Hono } from "hono";
import { createLogger } from "@synap-core/core";
import { emitSideEffects } from "@synap/events";
import { z } from "zod";

const logger = createLogger({ module: "n8n-webhooks" });

export const n8nWebhookRouter = new Hono();

// Webhook authentication middleware
const webhookAuth = async (c: any, next: () => Promise<void>) => {
  const secret = c.req.header("X-Webhook-Secret");
  const expectedSecret = process.env.N8N_WEBHOOK_SECRET;

  if (!expectedSecret) {
    logger.warn("N8N_WEBHOOK_SECRET not configured");
    return c.json({ error: "Webhook authentication not configured" }, 500);
  }

  if (
    !secret ||
    secret.length !== expectedSecret.length ||
    !timingSafeEqual(Buffer.from(secret), Buffer.from(expectedSecret))
  ) {
    logger.warn("Invalid webhook secret");
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
};

// Validation schema for inbox items
const InboxItemSchema = z.object({
  provider: z.string(),
  account: z.string(),
  externalId: z.string(),
  type: z.string(),
  title: z.string(),
  preview: z.string().optional(),
  timestamp: z.coerce.date(),
  deepLink: z.string().optional(),
  data: z.record(z.string(), z.unknown()),
});

/**
 * N8N Inbox Ingestion Webhook
 *
 * POST /webhooks/n8n/inbox
 * Headers: X-Webhook-Secret, X-User-Id, X-Workspace-Id
 * Body: { items: InboxItem[] }
 */
n8nWebhookRouter.post("/inbox", webhookAuth, async (c) => {
  try {
    const userId = c.req.header("X-User-Id");
    const workspaceId = c.req.header("X-Workspace-Id");

    if (!userId) return c.json({ error: "X-User-Id header required" }, 400);
    if (!workspaceId)
      return c.json({ error: "X-Workspace-Id header required" }, 400);

    const body = await c.req.json();
    const { items } = body;

    if (!Array.isArray(items)) {
      return c.json({ error: "items must be an array" }, 400);
    }

    logger.info(
      { userId, workspaceId, count: items.length },
      "Processing N8N inbox webhook"
    );

    const results = { published: 0, failed: 0, errors: [] as string[] };

    for (const item of items) {
      try {
        const validated = InboxItemSchema.parse(item);
        const itemId = `inbox_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // TODO: derive userId/workspaceId from a per-tenant DB-scoped secret instead of trusting headers
        await emitSideEffects({
          subjectType: "inbox_item",
          action: "received",
          subjectId: itemId,
          userId,
          workspaceId,
          data: {
            provider: validated.provider,
            account: validated.account,
            externalId: validated.externalId,
            type: validated.type,
            title: validated.title,
            preview: validated.preview,
            timestamp: validated.timestamp,
            deepLink: validated.deepLink,
            rawData: validated.data,
          },
        });

        results.published++;
      } catch (error: any) {
        logger.error({ error, item }, "Failed to process inbox item");
        results.failed++;
        results.errors.push(error.message);
      }
    }

    logger.info(results, "N8N inbox webhook processing complete");

    return c.json({ success: true, ...results });
  } catch (error: any) {
    logger.error({ error }, "N8N webhook handler error");
    return c.json(
      { error: "Internal server error", message: error.message },
      500
    );
  }
});

/**
 * Health check for webhooks
 */
n8nWebhookRouter.get("/health", (c) => {
  return c.json({ status: "ok", service: "n8n-webhooks" });
});
