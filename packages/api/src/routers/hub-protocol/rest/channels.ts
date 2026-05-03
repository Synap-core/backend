/**
 * Hub Protocol REST — channels (resolve channel by context, personal channel, AI trigger)
 */

import { z } from "@hono/zod-openapi";
import { db, agents, eq, and } from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  ChannelByContextRequestSchema,
  ChannelByContextResponseSchema,
  PersonalChannelQuerySchema,
  TriggerAiRequestSchema,
  WireChannelSchema,
} from "./_codecs/channel.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { getCaller, hasScope, logger, type HubHono } from "./_shared.js";

export function registerChannelsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/channels/by-context",
    tags: ["Channels"],
    summary: "Find or create a channel by context object",
    description:
      "Resolves (or creates) the AI channel scoped to a specific entity, document, or view.",
    request: {
      body: ChannelByContextRequestSchema,
    },
    responses: {
      200: {
        description: "Resolved channel",
        schema: ChannelByContextResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/channels/personal",
    tags: ["Channels"],
    summary: "Get the user's personal channel",
    description:
      "Returns the per-(user, workspace) personal AI channel, scoped to the orchestrator agent.",
    request: {
      query: PersonalChannelQuerySchema,
    },
    responses: {
      200: { description: "Channel", schema: WireChannelSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Orchestrator agent not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/channels/trigger-ai",
    tags: ["Channels", "Agents"],
    summary: "Trigger an AI response in a channel",
    description:
      "Posts a system-prompt-overridden message into the channel and dispatches the AI to respond. Used by skill triggers and proactive entry points.",
    request: {
      body: TriggerAiRequestSchema,
    },
    responses: {
      200: {
        description: "Trigger result (varies by skill/agent)",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /channels/by-context
   */
  app.post("/channels/by-context", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = (await c.req.json()) as {
      userId: string;
      workspaceId?: string;
      contextObjectId: string;
      contextObjectType: "entity" | "document" | "view";
    };
    if (!body.userId || !body.contextObjectId || !body.contextObjectType) {
      return c.json(
        {
          error: "userId, contextObjectId, and contextObjectType are required",
        },
        400
      );
    }
    try {
      const caller = await getCaller(c, {
        workspaceId: body.workspaceId,
        userId: body.userId,
      });
      const result = await caller.channels.resolveAiChannel({
        userId: body.userId,
        workspaceId: body.workspaceId,
        family: "context",
        contextObjectId: body.contextObjectId,
        contextObjectType: body.contextObjectType,
      });
      return c.json({
        channelId: result.channel.id,
        title: result.channel.title,
        created: true,
        channel: result.channel,
      });
    } catch (err) {
      logger.error({ err, body }, "channels/by-context failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * GET /channels/personal?userId=...&workspaceId=...
   */
  app.get("/channels/personal", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const userId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }
    try {
      const caller = await getCaller(c, { workspaceId, userId });
      const [agent] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
        .limit(1);
      if (!agent) {
        return c.json({ error: "Orchestrator agent not found" }, 404);
      }
      const result = await caller.channels.resolveAiChannel({
        userId,
        workspaceId,
        family: "agent",
        agentId: agent.id,
      });
      return c.json(result?.channel);
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "channels.ensurePersonal failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });

  /**
   * POST /channels/trigger-ai
   */
  app.post("/channels/trigger-ai", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = (await c.req.json()) as {
      channelId: string;
      userId: string;
      workspaceId: string;
      systemPromptOverride: string;
      skillId?: string;
      entityId?: string;
    };

    if (
      !body.channelId ||
      !body.systemPromptOverride ||
      !body.userId ||
      !body.workspaceId
    ) {
      return c.json(
        {
          error:
            "channelId, userId, workspaceId, and systemPromptOverride are required",
        },
        400
      );
    }

    try {
      const caller = await getCaller(c, {
        workspaceId: body.workspaceId,
        userId: body.userId,
      });
      const result = await caller.channels.triggerAI({
        channelId: body.channelId,
        userId: body.userId,
        workspaceId: body.workspaceId,
        systemPromptOverride: body.systemPromptOverride,
        skillId: body.skillId,
        entityId: body.entityId,
      });
      return c.json(result);
    } catch (err) {
      logger.error(
        { err, channelId: body.channelId },
        "channels.triggerAI failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500
      );
    }
  });
}
