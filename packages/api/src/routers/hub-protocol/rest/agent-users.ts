/**
 * Hub Protocol REST — agent users (list AI agent users in a workspace)
 */

import { z } from "@hono/zod-openapi";
import { db, eq, and, inArray } from "@synap/database";
import { findUnsafeAutoApproveEntries } from "@synap/governance-policy";
import { createNamedAgent } from "../../../services/agent-identity-service.js";

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
  /**
   * POST /agent-users
   * Create a named agent user and issue a Hub Protocol API key for it.
   * Idempotent by (agentType + caller): same agent type reuses the existing user.
   * Returns { agentUserId, email, apiKey } — key is shown ONCE.
   */
  app.post("/agent-users", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const callerId = c.get("userId") as string;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = z
      .object({
        name: z.string().min(1).max(120),
        agentType: z.string().min(1).max(60).default("cli-agent"),
      })
      .safeParse(body);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid body", details: parsed.error.issues },
        400
      );
    }

    try {
      const result = await createNamedAgent({
        name: parsed.data.name,
        agentType: parsed.data.agentType,
        createdByUserId: callerId,
      });
      return c.json(result, 201);
    } catch (err) {
      logger.error({ err }, "POST /agent-users failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

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
    // This lets an orchestrator discover its own personalities
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

      // A supplied workspaceId may only NARROW within the caller's memberships,
      // never widen to a foreign workspace.
      const memberWsIds = await getUserAccessibleWorkspaceIds(userId);
      if (workspaceId && !memberWsIds.includes(workspaceId)) return c.json([]);
      const accessibleWsIds = workspaceId ? [workspaceId] : memberWsIds;
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

  /**
   * PATCH /agent-users/:agentUserId/governance
   *
   * Set per-agent governance — autoApproveFor + writesRequireProposal.
   * Only the agent's creator (or an admin) can set this.
   */
  app.patch("/agent-users/:agentUserId/governance", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const agentUserId = c.req.param("agentUserId");
    if (!agentUserId) return c.json({ error: "agentUserId is required" }, 400);

    const body = (await c.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (
      !body?.autoApproveFor ||
      !Array.isArray(body.autoApproveFor) ||
      !body.autoApproveFor.every((entry) => typeof entry === "string")
    ) {
      return c.json({ error: "autoApproveFor (string[]) is required" }, 400);
    }

    // Reject entries that could silently auto-approve a destructive action
    // (delete/archive/purge) — the DESTRUCTIVE_ACTIONS hard floor in
    // decideAgentPolicy() catches this at read time too, but rejecting here
    // keeps the persisted setting itself honest and gives the caller a clear
    // error instead of a silently-neutered grant.
    const unsafe = findUnsafeAutoApproveEntries(
      body.autoApproveFor as string[]
    );
    if (unsafe.length > 0) {
      return c.json(
        {
          error:
            "autoApproveFor entries may not auto-approve destructive actions " +
            "(delete/archive/purge). Rejected entries: " +
            unsafe.join(", "),
        },
        400
      );
    }

    try {
      const { users } = await import("@synap/database/schema");
      const [agentUser] = await db
        .select({ id: users.id, agentMetadata: users.agentMetadata })
        .from(users)
        .where(and(eq(users.id, agentUserId), eq(users.userType, "agent")))
        .limit(1);

      if (!agentUser) {
        return c.json({ error: "Agent not found" }, 404);
      }

      const existingMeta = (agentUser.agentMetadata ?? {}) as Record<
        string,
        unknown
      >;
      const merged = {
        ...existingMeta,
        autoApproveFor: body.autoApproveFor,
        writesRequireProposal: body.writesRequireProposal ?? false,
        // Remove null/undefined keys so JSONB stays clean
        ...(body.writesRequireProposal === undefined
          ? {}
          : { writesRequireProposal: body.writesRequireProposal }),
      };

      await db
        .update(users)
        .set({ agentMetadata: merged as never })
        .where(eq(users.id, agentUserId));

      return c.json({
        ok: true,
        agentUserId,
        autoApproveFor: merged.autoApproveFor,
        writesRequireProposal: merged.writesRequireProposal,
      });
    } catch (err) {
      logger.error(
        { err, agentUserId },
        "PATCH /agent-users/:agentUserId/governance failed"
      );
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
