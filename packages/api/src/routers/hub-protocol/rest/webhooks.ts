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
 * AUTHORITY. Managing a subscription is a WRITE (`hub-protocol.write`;
 * listing needs `hub-protocol.read`). These handlers never pass the
 * governance gate, so what bounds a subscription is who created it:
 *
 * KEY-BOUND (S2 + D7, 2026-10-20). A subscription created by a key records it
 * (`api_key_id`); a key lists and deletes only the subscriptions it created,
 * a session (no key) every one of its owner's (`ownSubscriptions`). A
 * key-bound subscription is delivered only while its key lives and only what
 * its grant reads (`utils/webhook-delivery.ts`, jobs `webhook-worker.ts`), so
 * a SCOPED key may manage its own here (the fence no longer lists `/webhooks`
 * as owner-wide; the delivery log `/webhooks/:id/deliveries` still is). A
 * session's subscription keeps the owner-wide fan-out. A subscription whose
 * key is revoked or expired is listed inactive: it is not delivered.
 *
 * POD APPS (spec 17 PB4). A pod app may subscribe under its grant (the D7
 * rule above bounds what it receives), but only to a URL on its own site
 * (the origin of its metadata-document client_id). Its subscriptions move to
 * each new access key of its connection (`app-connect` `moveSlotWebhooks`),
 * so they survive the hourly rotation, and revoking the app deletes them.
 */

import { db, webhookSubscriptions, eq, and } from "@synap/database";
import {
  liveApiKeyIds,
  subscriptionKeyLive,
} from "@synap/jobs/workers/webhook-worker.js";
import { randomBytes } from "crypto";
import { z } from "zod";
import { podAppWebhookOrigin } from "../../../services/app-agent-floor.js";
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
      // A pod app (PB4) subscribes under its grant, to ITS OWN site only: its
      // subscriptions follow the connection across key rotations
      // (`moveSlotWebhooks`), so one created with a stolen 1 h token must not
      // be able to send the person's events anywhere else for as long as the
      // app keeps refreshing.
      const agentUserId = c.get("agentUserId") as string | undefined;
      const appOrigin = agentUserId
        ? await podAppWebhookOrigin(agentUserId)
        : null;
      if (appOrigin && new URL(url).origin !== appOrigin) {
        return c.json(
          {
            error: `A pod app's webhooks go to its own site only (${appOrigin}).`,
          },
          403
        );
      }
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

      // A subscription whose key is revoked or expired is not delivered, so
      // it shows inactive (S2) — the same liveness rule the delivery door uses.
      const live = await liveApiKeyIds(subscriptions.map((s) => s.apiKeyId));
      return c.json(
        subscriptions.map((s) => ({
          id: s.id,
          url: s.url,
          eventTypes: s.eventTypes,
          active: s.active && subscriptionKeyLive(s.apiKeyId, live),
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
