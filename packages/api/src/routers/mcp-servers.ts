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
import { router, protectedProcedure } from "../trpc.js";
import { AccessContext, scopedDb } from "../access/index.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, or, isNull, asc, inArray } from "@synap/database";
import { mcpServers } from "@synap/database/schema";
import { workspaceMembers, workspaces } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";
import { invalidateMcpCache } from "./channels.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";

/** Require owner or admin role — throws FORBIDDEN otherwise */
function requireAdminRole(role: string | undefined | null) {
  if (!["owner", "admin"].includes(role ?? "")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only workspace owners and admins can manage MCP servers.",
    });
  }
}

/**
 * Require pod-admin (owner/admin of the `pod-admin` system workspace) for
 * pod-wide (null-workspace) MCP servers. A pod-wide server is visible to every
 * workspace, so creating/re-pointing one is a pod-level privileged action —
 * mirrors `podAdminProcedure` in trpc.ts. Throws FORBIDDEN otherwise.
 */
async function requirePodAdmin(userId: string) {
  const podAdminWorkspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.systemSlug, "pod-admin"),
    columns: { id: true },
  });
  if (!podAdminWorkspace) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Pod administration workspace not found.",
    });
  }
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
      eq(workspaceMembers.userId, userId),
      inArray(workspaceMembers.role, ["admin", "owner"])
    ),
    columns: { role: true },
  });
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only pod administrators can manage pod-wide MCP servers.",
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
  transport: z.enum(["stdio", "http"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().url().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

async function getWorkspaceRole(userId: string, workspaceId: string) {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { role: true },
  });
  return membership?.role;
}

export const mcpServersRouter = router({
  /**
   * List all MCP servers for the current workspace.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().uuid().nullable().optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const workspaceId = input?.workspaceId ?? ctx.workspaceId ?? null;
      // scopedDb auto-ANDs the membership predicate — a caller-supplied
      // workspaceId they don't belong to yields nothing instead of leaking
      // other workspaces' MCP server configs.
      const servers = await scopedDb(AccessContext.from(ctx)).findMany<
        typeof mcpServers.$inferSelect
      >(mcpServers, {
        where: workspaceId
          ? or(
              eq(mcpServers.workspaceId, workspaceId),
              isNull(mcpServers.workspaceId)
            )
          : isNull(mcpServers.workspaceId),
        orderBy: asc(mcpServers.name),
      });
      return { servers };
    }),

  /**
   * Add a new MCP server to the workspace.
   * Requires owner or admin.
   */
  create: protectedProcedure
    .input(
      McpServerWriteSchema.extend({
        workspaceId: z.string().uuid().nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      if (input.workspaceId) {
        const role = await getWorkspaceRole(userId, input.workspaceId);
        requireAdminRole(role);
      } else {
        // Pod-wide server (null workspaceId) — pod-level privileged action.
        await requirePodAdmin(userId);
      }

      // Validate transport-specific required fields
      if (input.transport === "stdio" && !input.command) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "stdio transport requires a command.",
        });
      }
      if (input.transport === "http" && !input.url) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${input.transport} transport requires a URL.`,
        });
      }

      const [server] = await db
        .insert(mcpServers)
        .values({
          workspaceId: input.workspaceId ?? null,
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

      invalidateMcpCache(input.workspaceId ?? null);
      return { server };
    }),

  /**
   * Update an MCP server's configuration.
   * Requires owner or admin.
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        workspaceId: z.string().uuid().nullable().optional(),
        ...McpServerWriteSchema.partial().shape,
        enabled: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { id, workspaceId, ...fields } = input;

      const existing = await db.query.mcpServers.findFirst({
        where: eq(mcpServers.id, id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }
      if (existing.workspaceId) {
        const role = await getWorkspaceRole(userId, existing.workspaceId);
        requireAdminRole(role);
      } else {
        // Editing a pod-wide server is a pod-level privileged action.
        await requirePodAdmin(userId);
      }
      if (
        workspaceId !== undefined &&
        workspaceId !== null &&
        workspaceId !== existing.workspaceId
      ) {
        const targetRole = await getWorkspaceRole(userId, workspaceId);
        requireAdminRole(targetRole);
      }

      // Security: if any execution-defining field changes, the server may now
      // point somewhere different from what was approved — reset approval so an
      // approved server can't be silently re-pointed to run untrusted code.
      const RE_APPROVAL_FIELDS = [
        "command",
        "args",
        "env",
        "url",
        "transport",
      ] as const;
      const execChanged = RE_APPROVAL_FIELDS.some(
        (k) => (fields as Record<string, unknown>)[k] !== undefined
      );

      const [updated] = await db
        .update(mcpServers)
        .set({
          ...fields,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          ...(execChanged ? { approved: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, id))
        .returning();

      invalidateMcpCache(existing.workspaceId ?? null);
      invalidateMcpCache(updated.workspaceId ?? null);
      return { server: updated };
    }),

  /**
   * Approve or revoke approval for an MCP server's tools to be injected into LLM requests.
   * Requires owner only (security-critical action).
   */
  setApproved: protectedProcedure
    .input(z.object({ id: z.string().uuid(), approved: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const existing = await db.query.mcpServers.findFirst({
        where: eq(mcpServers.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }
      if (existing.workspaceId) {
        const role = await getWorkspaceRole(userId, existing.workspaceId);
        if (role !== "owner") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "Only workspace owners can approve MCP server tool access.",
          });
        }
      }

      const [updated] = await db
        .update(mcpServers)
        .set({ approved: input.approved, updatedAt: new Date() })
        .where(eq(mcpServers.id, input.id))
        .returning();

      invalidateMcpCache(existing.workspaceId ?? null);
      return { server: updated };
    }),

  /**
   * Ping an MCP server to test connectivity and update its status.
   * Delegates to the Intelligence Hub which manages active MCP connections.
   */
  ping: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const server = await db.query.mcpServers.findFirst({
        where: eq(mcpServers.id, input.id),
      });

      if (!server) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }
      if (server.workspaceId) {
        const role = await getWorkspaceRole(userId, server.workspaceId);
        requireAdminRole(role);
      }

      const { endpoint: hubUrl, serviceApiKey: hubApiKey } =
        await resolveIntelligenceService({
          userId: ctx.userId!,
          workspaceId: server.workspaceId ?? undefined,
        });

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
   * List the tools exposed by a specific MCP server.
   * Delegates to the Intelligence Hub which manages live connections.
   * Returns an empty array (not an error) when the Hub is unreachable or the server is offline.
   */
  listTools: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const server = await db.query.mcpServers.findFirst({
        where: eq(mcpServers.id, input.id),
      });

      if (!server) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }

      const { endpoint: hubUrl, serviceApiKey: hubApiKey } =
        await resolveIntelligenceService({
          userId: ctx.userId!,
          workspaceId: server.workspaceId ?? undefined,
        });

      try {
        const res = await fetch(`${hubUrl}/api/mcp/tools`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": hubApiKey,
          },
          body: JSON.stringify({
            servers: [
              {
                id: server.slug,
                name: server.name,
                transport: server.transport,
                command: server.command,
                args: server.args,
                url: server.url,
                env: server.env,
                enabled: server.enabled,
              },
            ],
          }),
        });
        if (!res.ok) return { tools: [] };
        const data = (await res.json()) as {
          tools?: Array<{ name: string; description: string }>;
        };
        return { tools: data.tools ?? [] };
      } catch {
        return { tools: [] };
      }
    }),

  /**
   * Delete an MCP server from the workspace.
   * Requires owner or admin.
   */
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);

      const existing = await db.query.mcpServers.findFirst({
        where: eq(mcpServers.id, input.id),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }
      if (existing.workspaceId) {
        const role = await getWorkspaceRole(userId, existing.workspaceId);
        requireAdminRole(role);
      }

      await db.delete(mcpServers).where(eq(mcpServers.id, input.id));

      invalidateMcpCache(existing.workspaceId ?? null);
      return { success: true };
    }),
});
