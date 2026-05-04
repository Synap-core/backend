/**
 * Hub Protocol REST — agent-configs
 *
 * Per-user, per-workspace, per-agent-type config overrides
 * (promptAppend, extraToolIds, disabledToolIds, maxStepsOverride, modelOverride).
 *
 * Used by orchestrators (e.g. Hermes daemon) to look up a personality's
 * configuration before spawning a subprocess. Read-only — writes flow through
 * the regular tRPC path used by the IS / CLI / browser.
 */

import { z } from "@hono/zod-openapi";
import { db, agentConfigs, eq, and } from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { hasScope, logger, type HubHono } from "./_shared.js";

const ListAgentConfigsQuerySchema = z
  .object({
    userId: z.string().describe("Agent user ID (the personality)."),
    workspaceId: z
      .string()
      .optional()
      .describe(
        "Workspace ID. If omitted, returns all configs for this userId across workspaces."
      ),
    agentType: z
      .string()
      .optional()
      .describe("Free-form agent type slug. If set, narrows to a single row."),
  })
  .openapi("ListAgentConfigsQuery");

const WireAgentConfigSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    workspaceId: z.string().nullable(),
    agentType: z.string(),
    promptAppend: z.string().nullable(),
    extraToolIds: z.array(z.string()),
    disabledToolIds: z.array(z.string()),
    maxStepsOverride: z.number().nullable(),
    modelOverride: z.string().nullable(),
    createdAt: z.union([z.string(), z.date()]),
    updatedAt: z.union([z.string(), z.date()]),
  })
  .passthrough()
  .openapi("AgentConfig");

export function registerAgentConfigsRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/agent-configs",
    tags: ["Agents"],
    summary: "List agent_configs rows",
    description:
      "Returns per-user/per-workspace/per-agentType config overrides. " +
      "Filter by userId (required), workspaceId (optional), agentType (optional). " +
      "The caller can only read configs whose userId is themselves OR an agent " +
      "user whose parentAgentId == caller.",
    request: {
      query: ListAgentConfigsQuerySchema,
    },
    responses: {
      200: {
        description: "Array of agent_configs rows",
        schema: z.array(WireAgentConfigSchema),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /agent-configs?userId=...[&workspaceId=...&agentType=...]
   *
   * Auth model: the caller is identified by their API key (`c.get("userId")`).
   * They can read configs only when:
   *   - the queried userId is themselves, OR
   *   - the queried userId is an agent user with parentAgentId == caller.
   * This matches the orchestrator-discovers-its-personalities pattern.
   */
  app.get("/agent-configs", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const callerId = c.get("userId") as string;
    const targetUserId = c.req.query("userId");
    const workspaceId = c.req.query("workspaceId");
    const agentType = c.req.query("agentType");

    if (!targetUserId) {
      return c.json({ error: "userId query param is required" }, 400);
    }

    try {
      // ── Authorization gate ────────────────────────────────────────────────
      if (targetUserId !== callerId) {
        const { users } = await import("@synap/database/schema");
        const target = await db.query.users.findFirst({
          where: and(eq(users.id, targetUserId), eq(users.userType, "agent")),
          columns: { id: true, agentMetadata: true },
        });
        const parentId =
          (target?.agentMetadata as { parentAgentId?: string } | null)
            ?.parentAgentId ?? null;
        if (!target || parentId !== callerId) {
          return c.json(
            {
              error:
                "Forbidden: caller is not the user nor the parent of the queried agent",
            },
            403
          );
        }
      }

      // ── Query ─────────────────────────────────────────────────────────────
      const conditions = [eq(agentConfigs.userId, targetUserId)];
      if (workspaceId) {
        conditions.push(eq(agentConfigs.workspaceId, workspaceId));
      }
      if (agentType) {
        conditions.push(eq(agentConfigs.agentType, agentType));
      }

      const rows = await db
        .select()
        .from(agentConfigs)
        .where(and(...conditions));

      return c.json(rows);
    } catch (err) {
      logger.error({ err }, "listAgentConfigs failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
