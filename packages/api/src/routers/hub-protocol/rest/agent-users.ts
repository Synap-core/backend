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
    const parentUserId = c.req.query("parentUserId");
    const userId = c.get("userId") as string;

    // Security gate: a caller can only filter by parentUserId === self.
    // This lets an orchestrator (e.g. Hermes) discover its own personalities
    // without exposing other agents' parent-child relationships.
    if (parentUserId && parentUserId !== userId) {
      return c.json(
        { error: "parentUserId must match the authenticated user" },
        403
      );
    }

    try {
      const { users, workspaceMembers } =
        await import("@synap/database/schema");

      // Parent-filter mode: skip the workspace-membership join (an orchestrator
      // and its personalities don't necessarily share workspace membership).
      // Authorization is enforced earlier (parentUserId === callerId), so
      // only the caller's own personalities are ever visible — the bypass is
      // intentional, not a footgun.
      //
      // Response shape is reduced to id/name/agentType only — we deliberately
      // do NOT return the full agentMetadata blob (it can carry sensitive
      // fields like `parentAgentId`, `capabilities`, audit hints). The
      // agentType is the only identity slug callers actually need.
      if (parentUserId) {
        const childAgents = await db
          .select({
            id: users.id,
            name: users.name,
            agentMetadata: users.agentMetadata,
          })
          .from(users)
          .where(
            and(
              eq(users.userType, "agent"),
              eq(users.parentAgentId, parentUserId)
            )
          );
        return c.json(
          childAgents.map((row) => {
            const meta = (row.agentMetadata ?? {}) as { agentType?: string };
            return {
              id: row.id,
              name: row.name,
              agentType: meta.agentType ?? null,
            };
          })
        );
      }

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
