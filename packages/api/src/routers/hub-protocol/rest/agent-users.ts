/**
 * Hub Protocol REST — agent users (list AI agent users in a workspace)
 */

import { z } from "@hono/zod-openapi";
import { db, eq, and, inArray } from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  ListAgentUsersQuerySchema,
  WireAgentUserSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getUserAccessibleWorkspaceIds,
  hasScope,
  logger,
  type HubHono,
} from "./_shared.js";

export function registerAgentUsersRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/agent-users",
    tags: ["Agents"],
    summary: "List AI agent users",
    description:
      "Returns users with userType='agent' that are members of the requested workspace (or any accessible workspace).",
    request: {
      query: ListAgentUsersQuerySchema,
    },
    responses: {
      200: {
        description: "Agent users",
        schema: z.array(WireAgentUserSchema),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /agent-users?workspaceId=...
   * List AI agent users in a workspace (so the hub can discover available agents).
   */
  app.get("/agent-users", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const workspaceId = c.req.query("workspaceId");
    const userId = c.get("userId") as string;
    try {
      const { users, workspaceMembers } =
        await import("@synap/database/schema");
      const accessibleWsIds = workspaceId
        ? [workspaceId]
        : await getUserAccessibleWorkspaceIds(userId);
      if (accessibleWsIds.length === 0) return c.json([]);
      const results = await db
        .select({
          id: users.id,
          name: users.name,
          agentMetadata: users.agentMetadata,
          role: workspaceMembers.role,
        })
        .from(users)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.userId, users.id),
            inArray(workspaceMembers.workspaceId, accessibleWsIds)
          )
        )
        .where(eq(users.userType, "agent"));
      return c.json(results);
    } catch (err) {
      logger.error({ err }, "listAgentUsers failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
