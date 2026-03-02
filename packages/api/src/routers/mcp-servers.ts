/**
 * MCP Servers Router
 *
 * Workspace-level CRUD for Model Context Protocol server configurations.
 * Promoted from workspaces.settings.mcpServers[] (JSONB blob) to a
 * proper table with per-server status, approval gating, and health tracking.
 *
 * Only workspace owners/admins can create, update, approve, or delete servers.
 * Any workspace member can list servers and see their status.
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and } from "@synap/database";
import { mcpServers } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";

/** Require owner or admin role — throws FORBIDDEN otherwise */
function requireAdminRole(role: string | undefined | null) {
  if (!["owner", "admin"].includes(role ?? "")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can manage MCP servers.",
    });
  }
}

const McpServerWriteSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(128),
  description: z.string().optional(),
  transport: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const mcpServersRouter = router({
  /**
   * List all MCP servers for the current workspace.
   */
  list: workspaceProcedure.query(async ({ ctx }) => {
    const servers = await db.query.mcpServers.findMany({
      where: eq(mcpServers.workspaceId, ctx.workspaceId!),
      orderBy: (t, { asc }) => [asc(t.name)],
    });
    return { servers };
  }),

  /**
   * Add a new MCP server to the workspace.
   * Requires owner or admin.
   */
  create: workspaceProcedure
    .input(McpServerWriteSchema)
    .mutation(async ({ ctx, input }) => {
      requireUserId(ctx.userId);
      requireAdminRole(ctx.workspaceRole);

      // Validate transport-specific required fields
      if (input.transport === "stdio" && !input.command) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "stdio transport requires a command.",
        });
      }
      if (["http", "sse"].includes(input.transport) && !input.url) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.transport} transport requires a URL.`,
        });
      }

      const [server] = await db
        .insert(mcpServers)
        .values({
          workspaceId: ctx.workspaceId!,
          slug: input.slug,
          name: input.name,
          description: input.description,
          transport: input.transport,
          command: input.command,
          args: input.args ?? [],
          url: input.url,
          env: input.env ?? {},
        })
        .returning();

      return { server };
    }),

  /**
   * Update an MCP server's configuration.
   * Requires owner or admin.
   */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        ...McpServerWriteSchema.partial().shape,
        enabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireAdminRole(ctx.workspaceRole);

      const { id, ...fields } = input;

      const existing = await db.query.mcpServers.findFirst({
        where: and(
          eq(mcpServers.id, id),
          eq(mcpServers.workspaceId, ctx.workspaceId!)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }

      const [updated] = await db
        .update(mcpServers)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(mcpServers.id, id))
        .returning();

      return { server: updated };
    }),

  /**
   * Approve or revoke approval for an MCP server's tools to be injected into LLM requests.
   * Requires owner only (security-critical action).
   */
  setApproved: workspaceProcedure
    .input(z.object({ id: z.string().uuid(), approved: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.workspaceRole !== "owner") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only workspace owners can approve MCP server tool access.",
        });
      }

      const existing = await db.query.mcpServers.findFirst({
        where: and(
          eq(mcpServers.id, input.id),
          eq(mcpServers.workspaceId, ctx.workspaceId!)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }

      const [updated] = await db
        .update(mcpServers)
        .set({ approved: input.approved, updatedAt: new Date() })
        .where(eq(mcpServers.id, input.id))
        .returning();

      return { server: updated };
    }),

  /**
   * Ping an MCP server to test connectivity and update its status.
   * Delegates to the Intelligence Hub which manages active MCP connections.
   */
  ping: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireAdminRole(ctx.workspaceRole);

      const server = await db.query.mcpServers.findFirst({
        where: and(
          eq(mcpServers.id, input.id),
          eq(mcpServers.workspaceId, ctx.workspaceId!)
        ),
      });

      if (!server) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }

      const hubUrl =
        process.env.INTELLIGENCE_HUB_URL ?? "http://localhost:3001";
      const hubApiKey = process.env.INTELLIGENCE_HUB_API_KEY ?? "";

      let newStatus: "connected" | "error" = "connected";
      let errorMessage: string | undefined;

      try {
        const res = await fetch(`${hubUrl}/api/mcp/ping`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": hubApiKey,
          },
          body: JSON.stringify({
            transport: server.transport,
            command: server.command,
            args: server.args,
            url: server.url,
            env: server.env,
          }),
        });
        if (!res.ok) {
          newStatus = "error";
          errorMessage = `Hub returned ${res.status}`;
        }
      } catch (err) {
        newStatus = "error";
        errorMessage = err instanceof Error ? err.message : "Connection failed";
      }

      const [updated] = await db
        .update(mcpServers)
        .set({
          status: newStatus,
          lastPingAt: new Date(),
          errorMessage: errorMessage ?? null,
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, input.id))
        .returning();

      return { server: updated };
    }),

  /**
   * Delete an MCP server from the workspace.
   * Requires owner or admin.
   */
  delete: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      requireAdminRole(ctx.workspaceRole);

      const existing = await db.query.mcpServers.findFirst({
        where: and(
          eq(mcpServers.id, input.id),
          eq(mcpServers.workspaceId, ctx.workspaceId!)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }

      await db.delete(mcpServers).where(eq(mcpServers.id, input.id));

      return { success: true };
    }),
});
