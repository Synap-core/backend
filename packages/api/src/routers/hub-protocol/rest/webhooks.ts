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

const CreateWebhookSchema = z.object({
  url: z.string().url(),
  eventTypes: z.array(z.string()).min(1),
  secret: z.string().optional(),
});

export function registerWebhooksRoutes(app: HubHono) {
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
    } catch (err) {
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
    } catch (err) {
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
    } catch (err) {
      return c.json({ error: "Failed to delete webhook subscription" }, 500);
    }
  });
}
