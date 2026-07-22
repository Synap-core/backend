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
  resolveActingContext,
  resolveActorId,
  type HubHono,
} from "./_shared.js";
import { resolveCaptureActorUserId } from "../../../services/capture-agent/resolve-capture-actor.js";
import { getConfinedWorkspace } from "../confine-workspace.js";
import { TRPCError } from "@trpc/server";

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
    // Bind the acting identity + workspace to the authenticated principal — a
    // session caller can't list another tenant's relations via ?userId=.
    const acting = await resolveActingContext(c, {
      userId: c.req.query("userId"),
      workspaceId: c.req.query("workspaceId"),
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;
    const entityId = c.req.query("entityId");
    const type = c.req.query("type");
    try {
      // No workspace lens → pod-wide user floor (all accessible workspaces +
      // pod-wide globals). A provided workspaceId narrows to that workspace,
      // unchanged. The pinned Discord bridge always passes a workspaceId, so its
      // behavior is untouched.
      if (!workspaceId) {
        const caller = await getCaller(c, { userId });
        const result = await caller.relations.listRelationsPodWide({
          userId,
          entityId,
          type,
        });
        return c.json(result);
      }
      const caller = await getCaller(c, { userId, workspaceId });
      const result = await caller.relations.listRelations({
        userId,
        workspaceId,
        entityId,
        type,
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
    // Service-key workspace confinement (Item 3): pin/clamp the requested
    // workspace before it reaches resolveActingContext and the re-supplied
    // createRelation input (`relations.create` prefers input.workspaceId).
    let requestedWorkspaceId: string | null | undefined;
    try {
      requestedWorkspaceId = getConfinedWorkspace(c, body.workspaceId);
    } catch (err) {
      if (err instanceof TRPCError && err.code === "FORBIDDEN")
        return c.json({ error: err.message }, 403);
      throw err;
    }
    // Bind the acting identity + workspace to the authenticated principal, and
    // membership-check the workspace for the resolved user (closes the IDOR).
    const acting = await resolveActingContext(c, {
      ...body,
      workspaceId: requestedWorkspaceId ?? undefined,
    });
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const { userId, workspaceId } = acting;
    // No 400 for a missing workspace: createRelation DERIVES it from the two
    // endpoints (rung 4). The service-key clamp already ran (getConfinedWorkspace
    // above), so a bound key stays pinned; an unbound/absent lens means "derive".
    try {
      // On the capture path (X-Capture: 1) attribute the edge to the seeded
      // Capture agent so relation.create auto-approves (its explicit
      // autoApproveFor covers it); a body-supplied agentUserId still wins, and a
      // non-capture caller keeps its own agent identity (normal governance).
      const resolvedAgentUserId = await resolveCaptureActorUserId(
        c,
        body.agentUserId
      );
      const actorResolution = await resolveActorId(resolvedAgentUserId, userId);
      if ("error" in actorResolution)
        return c.json({ error: actorResolution.error }, 400);
      const actorId = actorResolution.actorId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.relations.createRelation({
        userId,
        // null (pod-personal) → undefined so the door derives from the endpoints.
        ...(workspaceId ? { workspaceId } : {}),
        sourceEntityId: body.sourceEntityId,
        targetEntityId: body.targetEntityId,
        type: body.type,
        metadata: body.metadata,
        ...(resolvedAgentUserId ? { agentUserId: resolvedAgentUserId } : {}),
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

    // Service-key workspace confinement (Item 3): pin/clamp the requested
    // workspace at the point of read. A bound service key that omits it is
    // positive-pinned to its workspace (no pod-wide delete); a mismatch 403s.
    let requestedWorkspaceId: string | null | undefined;
    try {
      requestedWorkspaceId = getConfinedWorkspace(c, body.workspaceId);
    } catch (err) {
      if (err instanceof TRPCError && err.code === "FORBIDDEN")
        return c.json({ error: err.message }, 403);
      throw err;
    }

    // Bind the acting identity to the authenticated principal (closes the IDOR).
    // When workspaceId is given, membership-check it; when omitted the relation
    // is pod-wide (workspace = null) — preserve that without forcing resolution.
    const queryUserId = c.req.query("userId");
    let userId: string;
    let effectiveWorkspaceId: string | undefined;
    if (!requestedWorkspaceId) {
      const authUserId = c.get("userId") as string | undefined;
      if (!authUserId) return c.json({ error: "Unauthenticated" }, 403);
      const isServiceKey = !!c.get("apiKeyId");
      const claimed = body.userId ?? queryUserId;
      if (!isServiceKey && claimed && claimed !== authUserId) {
        return c.json(
          { error: "userId does not match the authenticated session" },
          403
        );
      }
      userId = isServiceKey ? (claimed ?? authUserId) : authUserId;
      effectiveWorkspaceId = undefined;
    } else {
      const acting = await resolveActingContext(c, {
        userId: body.userId ?? queryUserId,
        workspaceId: requestedWorkspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);
      userId = acting.userId;
      effectiveWorkspaceId = acting.workspaceId ?? undefined;
    }
    try {
      const actorId = body.agentUserId || userId;
      const caller = await getCaller(c, {
        userId: actorId,
        workspaceId: effectiveWorkspaceId,
        sourceMessageId: body.sourceMessageId,
      });
      const result = await caller.relations.deleteRelation({
        userId,
        workspaceId: effectiveWorkspaceId,
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
