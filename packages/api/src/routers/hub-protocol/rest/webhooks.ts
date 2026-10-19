/**
 * Hub Protocol REST — Webhook Subscriptions
 *
 * Allows Intelligence Services to register webhook subscriptions for
 * real-time event notifications, replacing polling.
 *
 * POST /api/hub/webhooks — create a webhook subscription
 * GET  /api/hub/webhooks — list webhook subscriptions
 * DELETE /api/hub/webhooks/:id — delete a webhook subscription
 *
 * AUTHORITY. A subscription is fanned out by OWNER only (webhook-worker
 * `fanOutDomainEvent`), so one row streams every event of the person to the URL
 * it names. Managing one is a WRITE (`hub-protocol.write`; listing needs
 * `hub-protocol.read`), and a scoped key may not use these doors at all unless
 * its grant is unbounded full access — the hub auth door refuses it
 * (`GRANT_OWNER_WIDE_REST_DOORS`, access/grant-door-fence.ts). These handlers
 * never pass the governance gate.
 *
 * KEY-BOUND (S2). A subscription created by a key records it (`api_key_id`);
 * a key lists and deletes only the subscriptions it created, a session (no
 * key) every one of its owner's (`ownSubscriptions`).
 */

import { db, webhookSubscriptions, eq, and } from "@synap/database";
import { randomBytes } from "crypto";
import { z } from "zod";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  httpStatusForTrpcError,
  requireUuidParam,
  type HubHono,
} from "./_shared.js";

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

/**
 * The subscriptions a caller manages (S2): a KEY sees only those it created
 * (`api_key_id`); a session (no key) sees every one of its owner's.
 */
function ownSubscriptions(userId: string, apiKeyId: string | undefined) {
  return apiKeyId
    ? and(
        eq(webhookSubscriptions.userId, userId),
        eq(webhookSubscriptions.apiKeyId, apiKeyId)
      )
    : eq(webhookSubscriptions.userId, userId);
}

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
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
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
          // S2: the creating key (null for a session) — delivery is then
          // bounded by that key's liveness and grant.
          apiKeyId: c.get("apiKeyId") ?? null,
          name: "is-webhook",
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
    } catch (_err) {
      return c.json(
        { error: "Failed to create webhook subscription" },
        httpStatusForTrpcError(_err)
      );
    }
  });

  app.get("/webhooks", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.get("userId");

    try {
      const subscriptions = await db.query.webhookSubscriptions.findMany({
        where: ownSubscriptions(userId, c.get("apiKeyId")),
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
    } catch (_err) {
      return c.json(
        { error: "Failed to list webhook subscriptions" },
        httpStatusForTrpcError(_err)
      );
    }
  });

  app.delete("/webhooks/:id", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const userId = c.get("userId");
    const id = requireUuidParam(c, "id");
    if (id instanceof Response) return id;
    try {
      const result = await db
        .delete(webhookSubscriptions)
        .where(
          and(
            eq(webhookSubscriptions.id, id),
            ownSubscriptions(userId, c.get("apiKeyId"))
          )
        )
        .returning();

      if (result.length === 0) {
        return c.json({ error: "Webhook subscription not found" }, 404);
      }

      return c.json({ success: true });
    } catch (_err) {
      return c.json(
        { error: "Failed to delete webhook subscription" },
        httpStatusForTrpcError(_err)
      );
    }
  });
}
