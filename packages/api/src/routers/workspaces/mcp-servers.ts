/**
 * Workspaces router — MCP server configuration procedures. Extracted
 * verbatim from `workspaces.ts` during router-decomposition Wave 6 — no
 * logic changed. Composed back into `workspacesRouter` by the barrel so the
 * generated `workspaces:` type stays byte-identical.
 */

import { z } from "zod";
import { protectedProcedure } from "../../trpc.js";
import {
  db,
  eq,
  and,
  workspaces,
  workspaceMembers,
  drizzleSql,
} from "@synap/database";
import type {
  WorkspaceSettings,
  McpServerConfig,
} from "@synap/database/schema";
import { TRPCError } from "@trpc/server";

export const mcpServersProcedures = {
  /**
   * Get workspace-level MCP server configurations.
   * These are user-added MCP servers applied to all AI requests in this workspace.
   */
  getMcpServers: protectedProcedure
    .input(z.object({ workspaceId: z.string() }))
    .query(async ({ input, ctx }) => {
      // Verify member access
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });

      const ws = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, input.workspaceId),
        columns: { settings: true },
      });
      return ((ws?.settings as WorkspaceSettings)?.mcpServers ??
        []) as McpServerConfig[];
    }),

  /**
   * Update workspace-level MCP server configurations.
   * Replaces the entire mcpServers array. Requires editor+ role.
   */
  updateMcpServers: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        servers: z.array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            transport: z.enum(["stdio", "http"]),
            command: z.string().optional(),
            args: z.array(z.string()).optional(),
            url: z.string().url().optional(),
            env: z.record(z.string(), z.string()).optional(),
            enabled: z.boolean().optional().default(true),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Require editor+ role
      const member = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, ctx.userId)
        ),
      });
      if (!member) throw new TRPCError({ code: "FORBIDDEN" });
      if (!["editor", "admin", "owner"].includes(member.role ?? "")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Editor role required to manage MCP servers",
        });
      }

      // Merge mcpServers into JSONB settings (preserves other settings fields)
      await db
        .update(workspaces)
        .set({
          settings: drizzleSql`settings || ${JSON.stringify({ mcpServers: input.servers })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(workspaces.id, input.workspaceId));

      return { count: input.servers.length };
    }),
};
