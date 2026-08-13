/**
 * Hub Protocol REST — Reactions / Pulse projection.
 *
 * Read-only facade over the reactive primitives on the event spine. Mirrors the
 * core tRPC `subscriptions.*` and `webhooks.deliveries` procedures so external
 * subscribers (the Reactions UI, OpenClaw) can read the same projection over
 * REST.
 *
 * GET /api/hub/subscriptions                  — user-wide Pulse feed
 * GET /api/hub/subscriptions/:eventId/fanout  — fan-out for one event
 * GET /api/hub/webhooks/:id/deliveries        — webhook delivery log
 *
 * Hono is first-match: the static `/subscriptions` list route is registered
 * BEFORE the dynamic `/subscriptions/:eventId/fanout` route.
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { errCode, hasScope, logger, type HubHono } from "./_shared.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { subscriptionsRouter } from "../../subscriptions.js";
import { webhooksRouter } from "../../webhooks.js";
import type { Context } from "../../../types/context.js";

const reactionKindSchema = z.enum([
  "automation",
  "ai_feed",
  "ai_react",
  "notify",
  "webhook",
  "message_out",
]);
const lensSchema = z.enum(["all", "internal", "external"]);

export function registerSubscriptionsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/subscriptions",
    tags: ["Subscriptions"],
    summary: "List the user-wide reactions (Pulse) feed",
    description:
      "Returns the timestamp-sorted union of reactive events for the user. Each item is a ReactionEvent shell; call /subscriptions/{eventId}/fanout for its dense reactions[].",
    request: {
      query: z.object({
        workspaceId: z.string().optional(),
        limit: z.coerce.number().min(1).max(500).optional(),
        kind: reactionKindSchema.optional(),
        eventType: z.string().optional(),
        lens: lensSchema.optional(),
      }),
    },
    responses: {
      200: { description: "Pulse feed", schema: z.object({}).passthrough() },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/subscriptions/{eventId}/fanout",
    tags: ["Subscriptions"],
    summary: "Get the reaction fan-out for one event",
    description:
      "Returns a single ReactionEvent with its reactions[] populated from automation runs, webhook deliveries, notifications, and correlated downstream events.",
    request: {
      params: z.object({ eventId: z.string() }),
      query: z.object({ lens: lensSchema.optional() }),
    },
    responses: {
      200: { description: "ReactionEvent", schema: z.object({}).passthrough() },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/webhooks/{id}/deliveries",
    tags: ["Webhooks"],
    summary: "List delivery log for a webhook subscription",
    description:
      "Returns the delivery log (status, responseStatus, attempt, deliveredAt) for a subscription owned by the caller. Powers the Reactions Health tab + Replay.",
    request: {
      params: z.object({ id: z.string() }),
      query: z.object({ limit: z.coerce.number().min(1).max(100).optional() }),
    },
    responses: {
      200: {
        description: "Delivery log",
        schema: z.array(z.object({}).passthrough()),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  // ── Handlers ─────────────────────────────────────────────────────────────

  // STATIC route first (Hono is first-match).
  app.get("/subscriptions", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const workspaceIdParam = c.req.query("workspaceId");
    const limitParam = c.req.query("limit");
    const kind = c.req.query("kind");
    const eventType = c.req.query("eventType");
    const lens = c.req.query("lens");

    try {
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      const caller = subscriptionsRouter.createCaller(ctx as Context);
      const result = await caller.listAll({
        workspaceId: workspaceIdParam ?? undefined,
        limit: limitParam ? parseInt(limitParam, 10) : 100,
        kind: kind as never,
        eventType: eventType || undefined,
        lens: (lens as never) ?? "all",
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "subscriptions list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // DYNAMIC route after the static one.
  app.get("/subscriptions/:eventId/fanout", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const eventId = c.req.param("eventId");
    const lens = c.req.query("lens");

    try {
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      const caller = subscriptionsRouter.createCaller(ctx as Context);
      const result = await caller.eventFanout({
        eventId,
        lens: (lens as never) ?? "all",
      });
      return c.json(result);
    } catch (err) {
      if (errCode(err) === "NOT_FOUND") {
        return c.json({ error: "Event not found" }, 404);
      }
      logger.error({ err, userId, eventId }, "subscriptions fanout failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  app.get("/webhooks/:id/deliveries", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    const id = c.req.param("id");
    const limitParam = c.req.query("limit");

    try {
      const ctx = await createHubProtocolCallerContext(userId, scopes);
      const caller = webhooksRouter.createCaller(ctx as Context);
      const result = await caller.deliveries({
        subscriptionId: id,
        limit: limitParam ? parseInt(limitParam, 10) : 50,
      });
      return c.json(result);
    } catch (err) {
      if (errCode(err) === "NOT_FOUND") {
        return c.json({ error: "Webhook subscription not found" }, 404);
      }
      logger.error({ err, userId, id }, "webhook deliveries failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
