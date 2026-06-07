/**
 * Hub Protocol REST — MCP servers
 */

import { z } from "@hono/zod-openapi";
import { db, mcpServers, eq, and, or, isNull } from "@synap/database";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  ListMcpServersQuerySchema,
  WireMcpServerSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  getUserAccessibleWorkspaceIds,
  type HubHono,
} from "./_shared.js";

export function registerMcpServersRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "get",
    path: "/mcp-servers",
    tags: ["MCP"],
    summary: "List approved MCP servers",
    description:
      "Returns approved + enabled MCP servers visible to the workspace (workspace-specific OR global).",
    request: {
      query: ListMcpServersQuerySchema,
    },
    responses: {
      200: { description: "MCP servers", schema: z.array(WireMcpServerSchema) },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * GET /mcp-servers?workspaceId=...
   * List workspace MCP servers for the Intelligence Service.
   * Returns only approved + enabled servers.
   */
  app.get("/mcp-servers", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const workspaceId = c.req.query("workspaceId");
    const userId = c.get("userId") as string;
    try {
      // Only widen to the requested workspace if the caller is a member —
      // otherwise restrict to pod-wide servers (no cross-workspace leak).
      let wsFilter = isNull(mcpServers.workspaceId);
      if (workspaceId) {
        const wsIds = await getUserAccessibleWorkspaceIds(userId);
        if (wsIds.includes(workspaceId)) {
          wsFilter = or(
            eq(mcpServers.workspaceId, workspaceId),
            isNull(mcpServers.workspaceId)
          )!;
        }
      }
      const rows = await db.query.mcpServers.findMany({
        where: and(
          wsFilter,
          eq(mcpServers.approved, true),
          eq(mcpServers.enabled, true)
        ),
        columns: {
          id: true,
          slug: true,
          name: true,
          description: true,
          approved: true,
          enabled: true,
          transport: true,
        },
      });
      return c.json(rows);
    } catch (err) {
      logger.error({ err, workspaceId }, "listMcpServers failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });
}
