/**
 * Hub Protocol REST — relations
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  CreateRelationRequestSchema,
  DeleteRelationRequestSchema,
  ListRelationsQuerySchema,
  WireRelationSchema,
} from "./_codecs/relation.js";
import {
  getCaller,
  hasScope,
  logger,
  resolveActorId,
  type HubHono,
} from "./_shared.js";

export function registerRelationsRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/relations",
    tags: ["Relations"],
    summary: "List relations",
    description:
      "Returns relations in a workspace. Filter by `entityId` (either side of the edge) and/or `type`.",
    request: {
      query: ListRelationsQuerySchema,
    },
    responses: {
      200: {
        description: "Array of relations",
        schema: z.array(WireRelationSchema),
      },
      400: { description: "Missing required param", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "post",
    path: "/relations",
    tags: ["Relations"],
    summary: "Create a relation",
    description: "Creates a typed edge between two entities.",
    request: {
      body: CreateRelationRequestSchema,
    },
    responses: {
      200: { description: "Created relation", schema: WireRelationSchema },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "delete",
    path: "/relations/{relationId}",
    tags: ["Relations"],
    summary: "Delete a relation",
    request: {
      params: z.object({ relationId: z.string() }),
      body: DeleteRelationRequestSchema,
    },
    responses: {
      200: {
        description: "Deletion result",
        schema: z.object({ ok: z.boolean() }).passthrough(),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /relations?userId=...&workspaceId=...&entityId=...&type=...
   */
  app.get("/relations", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    if (!userId || !workspaceId) {
      return c.json({ error: "userId and workspaceId are required" }, 400);
    }
    try {
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.relations.listRelations({
        userId,
        workspaceId,
        entityId: c.req.query("entityId"),
        type: c.req.query("type"),
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "listRelations failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * POST /relations
   */
  app.post("/relations", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const body = (await c.req.json()) as {
      userId: string;
      workspaceId: string;
      sourceEntityId: string;
      targetEntityId: string;
      type: string;
      metadata?: Record<string, unknown>;
      agentUserId?: string;
      reasoning?: string;
      sourceMessageId?: string;
    };
    try {
      const actorResolution = await resolveActorId(
        body.agentUserId,
        body.userId
      );
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId: body.workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.relations.createRelation({
        userId: body.userId,
        workspaceId: body.workspaceId,
        sourceEntityId: body.sourceEntityId,
        targetEntityId: body.targetEntityId,
        type: body.type,
        metadata: body.metadata,
        ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
        reasoning: body.reasoning,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err }, "createRelation failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  /**
   * DELETE /relations/:relationId
   */
  app.delete("/relations/:relationId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const relationId = c.req.param("relationId");
    const body = (await c.req.json().catch(() => null)) as {
      userId?: string;
      workspaceId?: string;
      agentUserId?: string;
      reasoning?: string;
      sourceMessageId?: string;
    } | null;
    if (!body) return c.json({ error: "Invalid JSON in request body" }, 400);
    const userId = body.userId ?? c.req.query("userId") ?? "";
    try {
      const actorId = body.agentUserId || userId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId: body.workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.relations.deleteRelation({
        userId,
        workspaceId: body.workspaceId,
        relationId,
        ...(body.agentUserId ? { agentUserId: body.agentUserId } : {}),
        reasoning: body.reasoning,
      });
      return c.json(result);
    } catch (err) {
      logger.error({ err, relationId }, "deleteRelation failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
