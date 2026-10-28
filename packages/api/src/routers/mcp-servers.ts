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
import {
  resolveIntelligenceService,
  selectIntelligenceService,
} from "../utils/intelligence-routing.js";
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

/**
 * The control-plane-provisioned intelligence service row
 * (`apps/api/src/routers/provision.ts` `/register-intelligence`): Synap's
 * SHARED, multi-tenant hub. The env fallback (`serviceId: "default"`) carries
 * no key, so it can never be the shared hub.
 */
const SHARED_HUB_SERVICE_ID = "synap-hub";

/** The hub's reason code when it refuses a stdio server (intelligence-service). */
const MCP_STDIO_NOT_ALLOWED = "MCP_STDIO_NOT_ALLOWED";

const STDIO_ON_SHARED_HUB_MESSAGE =
  "This hub does not run local commands; use an http MCP server.";

/**
 * The shared hub never spawns a pod's command (it would run as the hub, beside
 * every other customer). It refuses `stdio` itself with 403
 * MCP_STDIO_NOT_ALLOWED; the pod refuses first so the settings screen says why
 * instead of saving a server that can never run.
 */
async function servedBySharedHub(
  userId: string,
  workspaceId: string | null
): Promise<boolean> {
  const { service } = await selectIntelligenceService({
    userId,
    workspaceId: workspaceId ?? undefined,
  });
  return service?.serviceId === SHARED_HUB_SERVICE_ID;
}

function assertNotStdioOnSharedHub(
  server: { transport: string },
  serviceId: string
) {
  if (server.transport === "stdio" && serviceId === SHARED_HUB_SERVICE_ID) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: STDIO_ON_SHARED_HUB_MESSAGE,
    });
  }
}

/**
 * The hub's own refusal, read off a non-OK answer: its message when the body
 * carries `code: MCP_STDIO_NOT_ALLOWED`, else null (any other failure).
 */
async function hubStdioRefusal(res: Response): Promise<string | null> {
  if (res.status !== 403) return null;
  const body = (await res.json().catch(() => null)) as {
    code?: string;
    error?: string;
  } | null;
  if (body?.code !== MCP_STDIO_NOT_ALLOWED) return null;
  return body.error || STDIO_ON_SHARED_HUB_MESSAGE;
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
      if (
        input.transport === "stdio" &&
        (await servedBySharedHub(userId, input.workspaceId ?? null))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: STDIO_ON_SHARED_HUB_MESSAGE,
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

      // A save that leaves an ENABLED stdio server behind is refused on the
      // shared hub. Disabling a legacy stdio row stays possible (the browser's
      // full-object save re-sends `transport` even on an enabled-toggle).
      const nextTransport = fields.transport ?? existing.transport;
      const nextEnabled = fields.enabled ?? existing.enabled;
      if (
        nextTransport === "stdio" &&
        nextEnabled !== false &&
        (await servedBySharedHub(
          userId,
          workspaceId !== undefined ? workspaceId : existing.workspaceId
        ))
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: STDIO_ON_SHARED_HUB_MESSAGE,
        });
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

      const {
        endpoint: hubUrl,
        serviceApiKey: hubApiKey,
        serviceId,
      } = await resolveIntelligenceService({
        userId: ctx.userId!,
        workspaceId: server.workspaceId ?? undefined,
      });
      assertNotStdioOnSharedHub(server, serviceId);

      let newStatus: "connected" | "error" = "connected";
      let errorMessage: string | undefined;
      let refusedByHub: string | null = null;

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
          refusedByHub = await hubStdioRefusal(res);
          errorMessage = refusedByHub ?? `Hub returned ${res.status}`;
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

      // Recorded on the row above, AND surfaced: this is not "unreachable".
      if (refusedByHub) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: refusedByHub,
        });
      }
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

      const {
        endpoint: hubUrl,
        serviceApiKey: hubApiKey,
        serviceId,
      } = await resolveIntelligenceService({
        userId: ctx.userId!,
        workspaceId: server.workspaceId ?? undefined,
      });
      assertNotStdioOnSharedHub(server, serviceId);

      // A failed read is an ERROR, never "this server has no tools": the
      // caller (the tools list) would otherwise render a calm, wrong empty.
      let res: Response;
      try {
        res = await fetch(`${hubUrl}/api/mcp/tools`, {
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
      } catch (err) {
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: "Could not reach the intelligence service to list tools.",
          cause: err,
        });
      }
      if (!res.ok) {
        const refusedByHub = await hubStdioRefusal(res);
        if (refusedByHub)
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: refusedByHub,
          });
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: `The intelligence service could not list this server's tools (HTTP ${res.status}).`,
        });
      }
      const data = (await res.json().catch(() => null)) as {
        tools?: Array<{ name: string; description: string }>;
      } | null;
      if (!data)
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message:
            "The intelligence service answered the tools list unreadably.",
        });
      return { tools: data.tools ?? [] };
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
