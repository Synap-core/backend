/**
 * Hub Protocol REST — views
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  ArrangeViewRequestSchema,
  CreateViewRequestSchema,
  ListViewsQuerySchema,
  UpdateViewRequestSchema,
  WireViewSchema,
} from "./_codecs/view.js";
import {
  getCaller,
  hasScope,
  logger,
  resolveActorId,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

export function registerViewsRoutes(app: HubHono): void {
  // ── OpenAPI metadata for /views* routes ──────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/views",
    tags: ["Views"],
    summary: "List views",
    description:
      "Returns the user's views in a workspace, optionally filtered by view type or profile.",
    request: {
      query: ListViewsQuerySchema,
    },
    responses: {
      200: { description: "Array of views", schema: z.array(WireViewSchema) },
      400: { description: "Missing required param", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/views",
    tags: ["Views"],
    summary: "Create a view",
    description:
      "Creates a view (table, kanban, bento, etc.) over the entity store.",
    request: {
      body: CreateViewRequestSchema,
    },
    responses: {
      200: { description: "Created view", schema: WireViewSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/views/{viewId}",
    tags: ["Views"],
    summary: "Update a view",
    description: "Patch view name, config, or metadata.",
    request: {
      params: z.object({ viewId: z.string() }),
      body: UpdateViewRequestSchema,
    },
    responses: {
      200: { description: "Updated view", schema: WireViewSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/views/{viewId}/arrange",
    tags: ["Views"],
    summary: "Reorder/arrange widgets in a bento view",
    description:
      "Replaces the widget arrangement for a bento-type view. Widget IDs must reference existing cell instances in the view.",
    request: {
      params: z.object({ viewId: z.string() }),
      body: ArrangeViewRequestSchema,
    },
    responses: {
      200: { description: "Updated view", schema: WireViewSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      401: { description: "Unauthorized", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /views?userId=...&workspaceId=...&type=...&profileId=...
   */
  app.get("/views", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    // Derive the acting user from the authenticated principal when ?userId is
    // omitted (getCaller resolves the real owner regardless); only the workspace
    // lens comes from the query. Matches every other hub read — no other endpoint
    // forces the caller to carry the user UUID.
    const userId =
      c.req.query("userId") ?? (c.get("userId") as string | undefined);
    const workspaceId = c.req.query("workspaceId");
    if (!userId) {
      return c.json({ error: "Unauthenticated" }, 403);
    }
    try {
      const caller = await getCaller(c, {
        userId,
        workspaceId: workspaceId ?? null,
      });
      const result = await caller.views.listViews({
        userId,
        workspaceId: workspaceId ?? null,
        type: c.req.query("type"),
        profileId: c.req.query("profileId"),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "listViews failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /views
   */
  app.post("/views", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json()) as {
      userId: string;
      workspaceId?: string | null;
      name: string;
      type: string;
      profileId?: string;
      config?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      agentUserId?: string;
      reasoning?: string;
      sourceMessageId?: string;
    };
    try {
      const acting = await resolveActingContext(c, {
        userId: body.userId,
        ...(typeof body.workspaceId === "string"
          ? { workspaceId: body.workspaceId }
          : {}),
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId: acting.workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.views.createView({
        userId: acting.userId,
        workspaceId: acting.workspaceId,
        name: body.name,
        type: body.type,
        profileId: body.profileId,
        config: body.config,
        metadata: body.metadata,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        reasoning: body.reasoning,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "createView failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * PATCH /views/:viewId
   */
  app.patch("/views/:viewId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const viewId = c.req.param("viewId");
    const body = (await c.req.json()) as {
      userId: string;
      workspaceId?: string;
      name?: string;
      config?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      agentUserId?: string;
      reasoning?: string;
      sourceMessageId?: string;
    };
    try {
      const acting = await resolveActingContext(c, {
        userId: body.userId,
        ...(typeof body.workspaceId === "string"
          ? { workspaceId: body.workspaceId }
          : {}),
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const actorResolution = await resolveActorId(
        resolvedAgentUserId,
        acting.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId: acting.workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.views.updateView({
        userId: acting.userId,
        viewId,
        workspaceId: acting.workspaceId ?? undefined,
        name: body.name,
        config: body.config,
        metadata: body.metadata,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        reasoning: body.reasoning,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, viewId }, "updateView failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /views/:viewId/arrange
   */
  app.post("/views/:viewId/arrange", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const viewId = c.req.param("viewId");
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    try {
      const acting = await resolveActingContext(c, {
        userId: body?.userId,
        ...(typeof body?.workspaceId === "string"
          ? { workspaceId: body.workspaceId }
          : {}),
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      if (!acting.workspaceId) {
        return c.json({ error: "workspaceId is required" }, 400);
      }
      if (!acting.userId) {
        return c.json({ error: "Authenticated user is required" }, 401);
      }
      const caller = await getCaller(c, {
        userId: acting.userId,
        workspaceId: acting.workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const resolvedAgentUserId = body.agentUserId ?? ctxAgentUserId;
      const result = await caller.views.arrangeBento({
        userId: acting.userId,
        workspaceId: acting.workspaceId,
        viewId,
        widgets: body.widgets,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
        reasoning: body.reasoning,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, viewId }, "arrangeBento failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
