/**
 * Hub Protocol REST — Webhook Subscriptions
 *
 * Allows Intelligence Services (e.g. Hermes) to register webhook subscriptions
 * for real-time event notifications, replacing polling.
 *
 * POST /api/hub/webhooks — create a webhook subscription
 * GET  /api/hub/webhooks — list webhook subscriptions
 * DELETE /api/hub/webhooks/:id — delete a webhook subscription
 */

import type { HubHono } from "./_shared.js";
import { db, webhookSubscriptions, eq, and } from "@synap/database";
import { randomBytes } from "crypto";
import { z } from "zod";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";

const CreateWebhookSchema = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.string()).min(1),
  secret: z.string().optional(),
});

const WebhookResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  secret: z.string().optional(),
  active: z.boolean(),
  createdAt: z.string(),
});

const WebhookListItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  active: z.boolean(),
  createdAt: z.string(),
  lastTriggeredAt: z.string().nullable().optional(),
});

const WebhookIdParamsSchema = z.object({ id: z.string() });

export function registerWebhooksRoutes(app: HubHono) {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/webhooks",
    tags: ["Webhooks"],
    summary: "Create a webhook subscription",
    description:
      "Registers a webhook URL to receive real-time event notifications for the specified event types.",
    request: {
      body: CreateWebhookSchema,
    },
    responses: {
      201: {
        description: "Webhook subscription created",
        schema: WebhookResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/webhooks",
    tags: ["Webhooks"],
    summary: "List webhook subscriptions",
    description:
      "Returns all webhook subscriptions belonging to the authenticated agent user.",
    responses: {
      200: {
        description: "List of webhook subscriptions",
        schema: z.array(WebhookListItemSchema),
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "delete",
    path: "/webhooks/{id}",
    tags: ["Webhooks"],
    summary: "Delete a webhook subscription",
    description: "Permanently removes a webhook subscription by ID.",
    request: {
      params: WebhookIdParamsSchema,
    },
    responses: {
      200: {
        description: "Subscription deleted",
        schema: z.object({ success: z.boolean() }),
      },
      404: { description: "Subscription not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/webhooks", async (c) => {
    const userId = c.get("userId");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateWebhookSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join(", "),
        },
        400
      );
    }

    const { url, eventTypes, secret } = parsed.data;
    const webhookSecret = secret || randomBytes(32).toString("hex");

    try {
      const [subscription] = await db
        .insert(webhookSubscriptions)
        .values({
          userId,
          name: "hermes-webhook",
          url,
          eventTypes,
          secret: webhookSecret,
          active: true,
        })
        .returning();

      return c.json(
        {
          id: subscription.id,
          url: subscription.url,
          eventTypes: subscription.eventTypes,
          secret: webhookSecret,
          active: subscription.active,
          createdAt: subscription.createdAt,
        },
        201
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      return c.json({ error: "Failed to create webhook subscription" }, 500);
    }
  });

  app.get("/webhooks", async (c) => {
    const userId = c.get("userId");

    try {
      const subscriptions = await db.query.webhookSubscriptions.findMany({
        where: eq(webhookSubscriptions.userId, userId),
        orderBy: (subscriptions, { desc }) => [desc(subscriptions.createdAt)],
      });

      return c.json(
        subscriptions.map((s) => ({
          id: s.id,
          url: s.url,
          eventTypes: s.eventTypes,
          active: s.active,
          createdAt: s.createdAt,
          lastTriggeredAt: s.lastTriggeredAt,
        }))
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      return c.json({ error: "Failed to list webhook subscriptions" }, 500);
    }
  });

  app.delete("/webhooks/:id", async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");

    try {
      const result = await db
        .delete(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.id, id),
            eq(webhookSubscriptions.userId, userId)
          )
        )
        .returning();

      if (result.length === 0) {
        return c.json({ error: "Webhook subscription not found" }, 404);
      }

      return c.json({ success: true });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err) {
      return c.json({ error: "Failed to delete webhook subscription" }, 500);
    }
  });
}
