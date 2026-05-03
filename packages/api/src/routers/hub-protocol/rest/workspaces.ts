/**
 * Hub Protocol REST — workspaces & per-user context
 */

import { z } from "zod";
import { z as zOpenapi } from "@hono/zod-openapi";
import {
  db,
  sql,
  getDb,
  workspaces,
  workspaceMembers,
  eq,
  and,
  inArray,
  EventRepository,
  WorkspaceRepository,
} from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  EveProviderRoutingResponseSchema,
  EveProviderRoutingSchema,
  ListWorkspacesResponseSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getCaller,
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  type HubHono,
} from "./_shared.js";

const eveProviderIdSchema = z.enum([
  "ollama",
  "openrouter",
  "anthropic",
  "openai",
]);

const eveProviderRoutingPolicySchema = z.object({
  mode: z.enum(["local", "provider", "hybrid"]).optional(),
  defaultProvider: eveProviderIdSchema.optional(),
  fallbackProvider: eveProviderIdSchema.optional(),
  providers: z
    .array(
      z.object({
        id: eveProviderIdSchema,
        enabled: z.boolean().optional(),
        baseUrl: z.string().optional(),
        defaultModel: z.string().optional(),
      })
    )
    .optional(),
  syncToSynap: z.boolean().optional(),
});

export function registerWorkspacesRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/workspaces",
    tags: ["Workspaces"],
    summary: "List accessible workspaces",
    responses: {
      200: {
        description: "Workspaces accessible to the authenticated user",
        schema: ListWorkspacesResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "patch",
    path: "/workspaces/{workspaceId}/eve-provider-routing",
    tags: ["Workspaces"],
    summary: "Update Eve provider routing policy",
    description:
      "Persists the workspace's AI provider routing policy. Owner/admin role required.",
    request: {
      params: zOpenapi.object({ workspaceId: zOpenapi.string() }),
      body: EveProviderRoutingSchema,
    },
    responses: {
      200: {
        description: "Updated policy",
        schema: EveProviderRoutingResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: {
        description: "Forbidden — must be owner/admin",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/workspaces/{workspaceId}/governance",
    tags: ["Workspaces", "Governance"],
    summary: "Read workspace governance policy",
    description:
      "Returns the effective RBAC + auto-approve list for the workspace. Membership required.",
    request: {
      params: zOpenapi.object({ workspaceId: zOpenapi.string() }),
    },
    responses: {
      200: {
        description: "Governance policy",
        schema: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden — not a member", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/workspaces/{workspaceId}/eve-provider-routing",
    tags: ["Workspaces"],
    summary: "Read Eve provider routing policy",
    request: {
      params: zOpenapi.object({ workspaceId: zOpenapi.string() }),
    },
    responses: {
      200: {
        description: "Provider routing policy",
        schema: EveProviderRoutingResponseSchema,
      },
      403: { description: "Forbidden — not a member", schema: ErrorSchema },
      404: { description: "Workspace not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/users/{userId}/context",
    tags: ["Workspaces"],
    summary: "Get a user's context",
    description:
      "Returns workspaces + active workspace for a given user (used by IS to bootstrap session context).",
    request: {
      params: zOpenapi.object({ userId: zOpenapi.string() }),
    },
    responses: {
      200: {
        description: "User context",
        schema: zOpenapi.record(zOpenapi.string(), zOpenapi.unknown()),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /workspaces — list workspaces accessible to the authenticated user.
   */
  app.get("/workspaces", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const userId = c.get("userId") as string;
    try {
      const wsIds = await getUserAccessibleWorkspaceIds(userId);
      const list =
        wsIds.length > 0
          ? await db
              .select({ id: workspaces.id, name: workspaces.name })
              .from(workspaces)
              .where(inArray(workspaces.id, wsIds))
          : [];
      return c.json({ workspaces: list });
    } catch (err) {
      logger.error({ err }, "GET /workspaces failed");
      return c.json({ error: "Failed to list workspaces" }, 500);
    }
  });

  /**
   * PATCH /workspaces/:workspaceId/eve-provider-routing
   */
  app.patch("/workspaces/:workspaceId/eve-provider-routing", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);
    if (membership.role !== "owner" && membership.role !== "admin") {
      return c.json(
        { error: "Owner/admin role required to sync provider routing" },
        403
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = eveProviderRoutingPolicySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "Invalid provider routing payload",
          details: parsed.error.issues,
        },
        400
      );
    }

    try {
      const dbConn = await getDb();
      const eventRepo = new EventRepository(sql);
      const workspaceRepo = new WorkspaceRepository(dbConn, eventRepo);

      await workspaceRepo.mergeSettings(
        workspaceId,
        { eveProviderRouting: parsed.data },
        userId
      );

      return c.json({
        ok: true,
        workspaceId,
        eveProviderRouting: parsed.data,
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "PATCH /workspaces/:workspaceId/eve-provider-routing failed"
      );
      return c.json({ error: "Failed to sync provider routing" }, 500);
    }
  });

  /**
   * GET /workspaces/:workspaceId/governance
   */
  app.get("/workspaces/:workspaceId/governance", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);

    try {
      const { getEffectiveGovernance } =
        await import("../../../utils/permission-check.js");
      const policy = await getEffectiveGovernance(workspaceId);
      return c.json(policy);
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "GET /workspaces/:workspaceId/governance failed"
      );
      return c.json({ error: "Failed to read governance policy" }, 500);
    }
  });

  /**
   * GET /workspaces/:workspaceId/eve-provider-routing
   */
  app.get("/workspaces/:workspaceId/eve-provider-routing", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId is required" }, 400);

    const membership = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId)
      ),
      columns: { role: true },
    });
    if (!membership) return c.json({ error: "Access denied" }, 403);

    try {
      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, workspaceId),
        columns: { settings: true },
      });
      if (!workspace) return c.json({ error: "Workspace not found" }, 404);
      const settings = (workspace.settings ?? {}) as Record<string, unknown>;
      return c.json({
        ok: true,
        workspaceId,
        eveProviderRouting:
          (settings.eveProviderRouting as
            | Record<string, unknown>
            | undefined) ?? null,
      });
    } catch (err) {
      logger.error(
        { err, userId, workspaceId },
        "GET /workspaces/:workspaceId/eve-provider-routing failed"
      );
      return c.json({ error: "Failed to read provider routing" }, 500);
    }
  });

  /**
   * GET /users/:userId/context
   */
  app.get("/users/:userId/context", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const userId = c.req.param("userId");
    try {
      const caller = await getCaller(c);
      const result = await caller.context.getUserContext({ userId });
      return c.json(result);
    } catch (err) {
      logger.error({ err, userId }, "getUserContext failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
