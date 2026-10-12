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
import { db, eq, or, isNull, asc } from "@synap/database";
import { mcpServers } from "@synap/database/schema";
import { requireUserId } from "../utils/user-scoped.js";
import { invalidateMcpCache } from "./channels.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import {
  execFieldsChanged,
  MCP_SERVER_RE_APPROVAL_FIELDS,
} from "../services/capabilities/skill-exec-fields.js";
import {
  canManageMcpServer,
  requireServerManager,
} from "../utils/workspace-role.js";

/** What a caller who cannot manage a row sees in place of each env value. */
const MASKED_ENV_VALUE = "••••";

/**
 * A stdio server runs a COMMAND on the Intelligence Service. Nothing may spawn
 * it — not even a ping or a tool listing — until an owner has approved it.
 */
function assertSpawnable(server: { transport: string; approved: boolean }) {
  if (server.transport === "stdio" && !server.approved) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "This MCP server runs a local command — approve this server first.",
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
      // `env` carries credentials. Every member may SEE a server (its status,
      // its tools); only someone who may manage that row sees the values.
      const userId = requireUserId(ctx.userId);
      const manages = new Map<string | null, boolean>();
      for (const s of servers) {
        if (!manages.has(s.workspaceId)) {
          manages.set(
            s.workspaceId,
            await canManageMcpServer(userId, s.workspaceId)
          );
        }
      }
      return {
        servers: servers.map((s) =>
          manages.get(s.workspaceId)
            ? s
            : {
                ...s,
                env: Object.fromEntries(
                  Object.keys(s.env ?? {}).map((k) => [k, MASKED_ENV_VALUE])
                ),
              }
        ),
      };
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
      await requireServerManager(userId, input.workspaceId ?? null);

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
      await requireServerManager(userId, existing.workspaceId);
      // Moving the row into another scope needs the same right THERE —
      // including INTO pod-wide (null), which makes it visible to every
      // workspace's agents.
      if (workspaceId !== undefined && workspaceId !== existing.workspaceId) {
        await requireServerManager(userId, workspaceId);
      }

      // Security: if any execution-defining field changes, the server may now
      // point somewhere different from what was approved — reset approval so an
      // approved server can't be silently re-pointed to run untrusted code.
      // The field list is shared with the template applier
      // (`create-from-definition.ts`), which rewrites the same columns on a
      // capability re-apply — one list, so the two doors cannot drift.
      // VALUE, not PRESENCE. `saveEdit()` in the browser's MCP settings is a
      // full-object form save: it re-sends transport/command/args/url on every
      // save, so a presence test un-approved the server on a rename or an
      // enabled-toggle — silently pulling its tools out of LLM requests.
      // The comparison rule is shared with the skill and tool doors.
      const execChanged = execFieldsChanged(
        MCP_SERVER_RE_APPROVAL_FIELDS,
        fields as Record<string, unknown>,
        existing as unknown as Record<string, unknown>
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
      await requireServerManager(userId, existing.workspaceId, "owner");

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
      await requireServerManager(userId, server.workspaceId);
      assertSpawnable(server);

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
      // Route through scopedDb so the mcpServers VisibilityRule floors this read:
      // listing a server's tools must not expose another workspace's server
      // config (command/args/env/url) to a non-member. (Cross-workspace read fix.)
      const server = await scopedDb(AccessContext.from(ctx)).findFirst<
        typeof mcpServers.$inferSelect
      >(mcpServers, {
        where: eq(mcpServers.id, input.id),
      });

      if (!server) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "MCP server not found.",
        });
      }
      assertSpawnable(server);

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
      await requireServerManager(userId, existing.workspaceId);

      await db.delete(mcpServers).where(eq(mcpServers.id, input.id));

      invalidateMcpCache(existing.workspaceId ?? null);
      return { success: true };
    }),
});
