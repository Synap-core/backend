/**
 * Hub Protocol REST — proactive (IS → user's proactive feed channel)
 */

import { db, messages, eq, and, gte } from "@synap/database";

import { routeSignal } from "../../../utils/delivery-router.js";
import type { ProactiveMessageType } from "../../../services/DeliveryService.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  ProactivePostRequestSchema,
  ProactivePostResponseSchema,
} from "./_codecs/proactive.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

export function registerProactiveRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/proactive/post",
    tags: ["Proactive"],
    summary: "Post a proactive message into the user's feed channel",
    description:
      "Rate-limited: max 3 messages/hour and 10/day per (user, workspace). Returns posted=false when rate-limited.",
    request: {
      body: ProactivePostRequestSchema,
    },
    responses: {
      200: {
        description: "Delivery result (may be posted=false when rate-limited)",
        schema: ProactivePostResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: {
        description: "Internal error",
        schema: ProactivePostResponseSchema,
      },
    },
  });

  /**
   * POST /proactive/post
   * Allows the Intelligence Service to proactively post a message into a
   * user's proactive FEED channel.
   *
   * Rate-limited: max 3 messages/hour and 10 messages/24h per user+workspace.
   */
  app.post("/proactive/post", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const body = (await c.req.json()) as {
      userId?: string;
      workspaceId?: string;
      content?: string;
      proactiveType?: string;
      reasoning?: string;
      metadata?: Record<string, unknown>;
    };

    // ── Input validation ────────────────────────────────────────────────────
    if (
      !body.userId ||
      !body.workspaceId ||
      !body.content ||
      !body.proactiveType
    ) {
      return c.json(
        {
          error: "userId, workspaceId, content, and proactiveType are required",
        },
        400
      );
    }

    const VALID_PROACTIVE_TYPES = [
      "insight",
      "suggestion",
      "alert",
      "nudge",
      "morning_briefing",
      "weekly_digest",
      "health_check",
    ] as const;

    if (
      !(VALID_PROACTIVE_TYPES as readonly string[]).includes(body.proactiveType)
    ) {
      return c.json(
        {
          error: `Invalid proactiveType "${body.proactiveType}". Must be one of: ${VALID_PROACTIVE_TYPES.join(", ")}`,
        },
        400
      );
    }

    if (body.content.length > 10000) {
      return c.json({ error: "content must be at most 10000 characters" }, 400);
    }

    try {
      // ── Rate limiting (DB-backed) ───────────────────────────────────────────
      const { ensureProactiveFeedChannel } =
        await import("../../../utils/personal-channel.js");
      const channel = await ensureProactiveFeedChannel(
        body.userId,
        body.workspaceId
      );

      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      const recentMessages = await db.query.messages.findMany({
        where: and(
          eq(messages.channelId, channel.id),
          eq(messages.role, "system"),
          gte(messages.timestamp, twentyFourHoursAgo)
        ),
        columns: { metadata: true, timestamp: true },
      });

      // Filter to proactive messages only
      const proactiveMessages = recentMessages.filter((m) => {
        const meta = m.metadata as Record<string, unknown> | null;
        return meta?.proactiveAi === true;
      });

      const lastHourCount = proactiveMessages.filter(
        (m) => m.timestamp >= oneHourAgo
      ).length;
      const last24hCount = proactiveMessages.length;

      if (lastHourCount >= 3) {
        return c.json({
          posted: false,
          reason: "rate_limited",
          detail: "Maximum 3 proactive messages per hour exceeded",
        });
      }

      if (last24hCount >= 10) {
        return c.json({
          posted: false,
          reason: "rate_limited",
          detail: "Maximum 10 proactive messages per 24 hours exceeded",
        });
      }

      // ── Route the signal via delivery router ───────────────────────────────
      const result = await routeSignal({
        domain: "ai_insight",
        content: body.content,
        userId: body.userId,
        workspaceId: body.workspaceId,
        proactiveType: body.proactiveType as ProactiveMessageType,
        metadata: {
          ...body.metadata,
          ...(body.reasoning ? { reasoning: body.reasoning } : {}),
        },
      });

      return c.json({ posted: result.delivered, ...result });
    } catch (err) {
      logger.error(
        { err, userId: body.userId, workspaceId: body.workspaceId },
        "proactive/post failed"
      );
      return c.json(
        {
          posted: false,
          reason: err instanceof Error ? err.message : "unknown_error",
        },
        500
      );
    }
  });
}
