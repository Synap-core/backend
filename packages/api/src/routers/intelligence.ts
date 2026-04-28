/**
 * Intelligence Router
 *
 * Commands (Raycast-style), runs (audit), effective service (manifest),
 * and proxy procedures for intelligence service management APIs
 * (agents, tools, memory, skills, executions, proposals).
 */

import { z } from "zod";
import { router, workspaceProcedure, podProcedure } from "../trpc.js";
import type { Context } from "../context.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, desc, or, like, sql, drizzleSql } from "@synap/database";
import {
  intelligenceCommands,
  commandRuns,
  channels,
  entities,
  ChannelType,
  ChannelStatus,
  intelligenceServices,
  users,
  apiKeys,
  mcpServers,
  compactedStates,
  type NewIntelligenceCommand,
  type AgentMetadata,
} from "@synap/database/schema";
import { workspaces } from "@synap/database/schema";
import { EventRepository, ApiKeyRepository } from "@synap/database";
import { randomUUID, randomBytes } from "crypto";
import { SERVICE_CATALOG } from "../utils/agent-services/index.js";
import {
  parseCommandTemplate,
  validateArgumentValues,
  type SelectionContext,
} from "../utils/command-template.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { requireUserId } from "../utils/user-scoped.js";
import {
  ensureAgentThread,
  getAgentIdBySlug,
} from "../utils/personal-channel.js";
import { channelsRouter, invalidateMcpCache } from "./channels.js";

// ── Shared proxy response types ───────────────────────────────────────────

export interface ToolLog {
  id?: string;
  toolName?: string;
  tool_name?: string;
  durationMs?: number;
  error?: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

export interface ExecutionRecord {
  id: string;
  agentType?: string;
  status?: string;
  durationMs?: number;
  createdAt?: string;
  completedAt?: string;
  messageCount?: number;
  [key: string]: unknown;
}

export interface ExecutionStats {
  totalRuns?: number;
  successRate?: number;
  avgDurationMs?: number;
  toolCallCount?: number;
  [key: string]: unknown;
}

// ── Intelligence Service Proxy Helpers ─────────────────────────────────────

/** Fetch from the intelligence service Hub API (e.g. /api/hub/memory) */
async function hubProxyFetch(
  endpoint: string,
  serviceUrl: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${serviceUrl}/api/hub${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Intelligence service error (${res.status}): ${text}`,
    });
  }
  return res;
}

/** Fetch from the intelligence service management API (e.g. /api/executions) */
async function apiProxyFetch(
  endpoint: string,
  serviceUrl: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${serviceUrl}/api${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Intelligence service error (${res.status}): ${text}`,
    });
  }
  return res;
}

/** Resolve the intelligence service endpoint + API key for the current workspace */
async function getServiceEndpoint(
  userId: string,
  workspaceId: string
): Promise<{ endpoint: string; apiKey: string }> {
  const resolved = await resolveIntelligenceService({
    userId,
    workspaceId,
    capability: "chat",
  });
  return { endpoint: resolved.endpoint, apiKey: resolved.serviceApiKey };
}

/** Default (proprietary) Synap Intelligence service manifest — used when no custom service is configured. */
const DEFAULT_SERVICE_MANIFEST = {
  name: "Synap Intelligence",
  version: "1.0",
  capabilities: [
    "chat",
    "analysis",
    "commands",
    "proposals",
    "threads",
  ] as string[],
};

const selectionContextSchema = z.object({
  type: z.enum(["entities", "viewRows", "documents", "text"]),
  entityIds: z.array(z.string().uuid()).optional(),
  viewId: z.string().uuid().optional(),
  rowEntityIds: z.array(z.string().uuid()).optional(),
  documentIds: z.array(z.string().uuid()).optional(),
  text: z.string().optional(),
});

export const intelligenceRouter = router({
  /** List commands for workspace */
  listCommands: workspaceProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const list = await db.query.intelligenceCommands.findMany({
        where: eq(intelligenceCommands.workspaceId, ctx.workspaceId!),
        orderBy: desc(intelligenceCommands.updatedAt),
        limit: input.limit,
      });
      return { commands: list };
    }),

  /** Get one command by id; verify workspace access */
  getCommand: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const cmd = await db.query.intelligenceCommands.findFirst({
        where: eq(intelligenceCommands.id, input.id),
      });
      if (!cmd || cmd.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Command not found",
        });
      }
      return cmd;
    }),

  /** Create command; compile template to derived_inputs */
  createCommand: workspaceProcedure
    .input(
      z.object({
        title: z.string().min(1),
        promptTemplate: z.string().min(1),
        inputOverrides: z.record(z.string(), z.any()).optional(),
        allowedTools: z.array(z.string()).optional(),
        allowedEntityTypes: z.array(z.string()).optional(),
        maxEntitiesCreatedPerRun: z.number().int().positive().optional(),
        canCreateViews: z.boolean().optional(),
        outputMode: z.enum(["text", "proposal", "view"]).optional(),
        permissionsProfile: z.enum(["read_only", "propose_writes"]).optional(),
        sharedScope: z.enum(["workspace", "user"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { derivedInputs } = parseCommandTemplate(input.promptTemplate);
      const insertResult = await db
        .insert(intelligenceCommands)
        .values({
          workspaceId: ctx.workspaceId!,
          createdBy: userId,
          title: input.title,
          promptTemplate: input.promptTemplate,
          compiledTemplateAst: null,
          derivedInputs,
          inputOverrides: input.inputOverrides ?? undefined,
          allowedTools: input.allowedTools ?? undefined,
          allowedEntityTypes: input.allowedEntityTypes ?? undefined,
          maxEntitiesCreatedPerRun: input.maxEntitiesCreatedPerRun ?? undefined,
          canCreateViews: input.canCreateViews ?? false,
          outputMode: input.outputMode ?? "text",
          permissionsProfile: input.permissionsProfile ?? "propose_writes",
          sharedScope: input.sharedScope ?? "workspace",
        } as NewIntelligenceCommand)
        .returning();
      const [row] = insertResult;
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      return row;
    }),

  /** Update command; recompile template if promptTemplate changed */
  updateCommand: workspaceProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().min(1).optional(),
        promptTemplate: z.string().min(1).optional(),
        inputOverrides: z.record(z.string(), z.any()).optional(),
        allowedTools: z.array(z.string()).optional(),
        allowedEntityTypes: z.array(z.string()).optional(),
        maxEntitiesCreatedPerRun: z
          .number()
          .int()
          .positive()
          .optional()
          .nullable(),
        canCreateViews: z.boolean().optional(),
        outputMode: z.enum(["text", "proposal", "view"]).optional(),
        permissionsProfile: z.enum(["read_only", "propose_writes"]).optional(),
        sharedScope: z.enum(["workspace", "user"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const cmd = await db.query.intelligenceCommands.findFirst({
        where: eq(intelligenceCommands.id, input.id),
      });
      if (!cmd || cmd.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Command not found",
        });
      }
      const updates: Record<string, unknown> = {
        updatedAt: new Date(),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.inputOverrides !== undefined && {
          inputOverrides: input.inputOverrides,
        }),
        ...(input.allowedTools !== undefined && {
          allowedTools: input.allowedTools,
        }),
        ...(input.allowedEntityTypes !== undefined && {
          allowedEntityTypes: input.allowedEntityTypes,
        }),
        ...(input.maxEntitiesCreatedPerRun !== undefined && {
          maxEntitiesCreatedPerRun: input.maxEntitiesCreatedPerRun,
        }),
        ...(input.canCreateViews !== undefined && {
          canCreateViews: input.canCreateViews,
        }),
        ...(input.outputMode !== undefined && { outputMode: input.outputMode }),
        ...(input.permissionsProfile !== undefined && {
          permissionsProfile: input.permissionsProfile,
        }),
        ...(input.sharedScope !== undefined && {
          sharedScope: input.sharedScope,
        }),
      };
      if (input.promptTemplate !== undefined) {
        const { derivedInputs } = parseCommandTemplate(input.promptTemplate);
        updates.promptTemplate = input.promptTemplate;
        updates.derivedInputs = derivedInputs;
      }
      const updateResult = await db
        .update(intelligenceCommands)
        .set(updates)
        .where(eq(intelligenceCommands.id, input.id))
        .returning();
      const [updated] = updateResult;
      if (!updated) throw new TRPCError({ code: "NOT_FOUND" });
      return updated;
    }),

  /** Delete command */
  deleteCommand: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const cmd = await db.query.intelligenceCommands.findFirst({
        where: eq(intelligenceCommands.id, input.id),
      });
      if (!cmd || cmd.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Command not found",
        });
      }
      await db
        .delete(intelligenceCommands)
        .where(eq(intelligenceCommands.id, input.id));
      return { success: true };
    }),

  /** Run command: create thread + run, then call chat.sendMessage for streaming */
  runCommand: workspaceProcedure
    .input(
      z.object({
        commandId: z.string().uuid(),
        argumentValues: z.record(z.string(), z.string()).default({}),
        selectionContext: selectionContextSchema.optional(),
        currentUrl: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const workspaceId = ctx.workspaceId!;

      const cmd = await db.query.intelligenceCommands.findFirst({
        where: eq(intelligenceCommands.id, input.commandId),
      });
      if (!cmd || cmd.workspaceId !== workspaceId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Command not found",
        });
      }

      const parsedTemplate = parseCommandTemplate(cmd.promptTemplate);
      const missing = validateArgumentValues(
        cmd.derivedInputs ?? [],
        input.argumentValues
      );
      if (missing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Missing argument values: ${missing.join(", ")}`,
        });
      }

      // Resolve static entity refs (@{entity:ID:name}) from the DB
      const resolvedEntities: Record<string, string> = {};
      for (const ref of parsedTemplate.staticRefs) {
        const entity = await db.query.entities.findFirst({
          where: and(
            eq(entities.id, ref.entityId),
            eq(entities.workspaceId, workspaceId)
          ),
        });
        resolvedEntities[ref.entityId] = entity
          ? `${entity.title ?? entity.type} (${entity.type})`
          : ref.displayName;
      }

      // Resolve @{context:entity} — look up the first entity from selectionContext
      const hasEntityContext = parsedTemplate.contextRefs.some(
        (r) => r.contextType === "entity"
      );
      if (hasEntityContext && input.selectionContext?.entityIds?.[0]) {
        const ctxEntityId = input.selectionContext.entityIds[0];
        const ctxEntity = await db.query.entities.findFirst({
          where: and(
            eq(entities.id, ctxEntityId),
            eq(entities.workspaceId, workspaceId)
          ),
        });
        if (ctxEntity) {
          resolvedEntities["__context_entity"] =
            `${ctxEntity.title ?? ctxEntity.type} (${ctxEntity.type})`;
        }
      }

      const resolvedUrl = input.currentUrl;

      const compiledPrompt = parsedTemplate.substitute(
        input.argumentValues,
        input.selectionContext as SelectionContext | undefined,
        resolvedEntities,
        resolvedUrl
      );

      const [thread] = await db
        .insert(channels)
        .values({
          userId,
          workspaceId,
          channelType: ChannelType.THREAD,
          status: ChannelStatus.ACTIVE,
        })
        .returning();
      if (!thread) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const permissionsSnapshot = {
        allowedTools: cmd.allowedTools,
        allowedEntityTypes: cmd.allowedEntityTypes,
        maxEntitiesCreatedPerRun: cmd.maxEntitiesCreatedPerRun,
        canCreateViews: cmd.canCreateViews,
        permissionsProfile: cmd.permissionsProfile,
      };

      const [run] = await db
        .insert(commandRuns)
        .values({
          threadId: thread.id,
          commandId: cmd.id,
          workspaceId,
          userId,
          permissionsSnapshot,
          inputs: input.argumentValues,
          selectionContextSnapshot: input.selectionContext ?? undefined,
          status: "running",
        })
        .returning();
      if (!run) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      try {
        const chatCaller = channelsRouter.createCaller(
          ctx as unknown as Context
        );
        await chatCaller.sendMessage({
          channelId: thread.id,
          content: compiledPrompt,
          workspaceId,
        });

        await db
          .update(commandRuns)
          .set({
            status: "completed",
            completedAt: new Date(),
          })
          .where(eq(commandRuns.id, run.id));
      } catch (err) {
        await db
          .update(commandRuns)
          .set({
            status: "failed",
            completedAt: new Date(),
            errorMessage: err instanceof Error ? err.message : String(err),
          })
          .where(eq(commandRuns.id, run.id));
        throw err;
      }

      return { runId: run.id, threadId: thread.id };
    }),

  /** List runs for workspace */
  listRuns: workspaceProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(50),
        cursor: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const conditions = [eq(commandRuns.workspaceId, ctx.workspaceId!)];
      const list = await db.query.commandRuns.findMany({
        where: and(...conditions),
        orderBy: desc(commandRuns.startedAt),
        limit: input.limit + 1,
      });
      const hasMore = list.length > input.limit;
      const runs = hasMore ? list.slice(0, input.limit) : list;
      const nextCursor = hasMore ? runs[runs.length - 1]?.id : undefined;
      return { runs, nextCursor, hasMore };
    }),

  /** Get one run; verify workspace */
  getRun: workspaceProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const run = await db.query.commandRuns.findFirst({
        where: eq(commandRuns.id, input.id),
      });
      if (!run || run.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
      }
      return run;
    }),

  /** Effective intelligence service for workspace (manifest for UI) */
  getEffectiveService: workspaceProcedure
    .input(z.object({}))
    .query(async ({ ctx }) => {
      const resolved = await resolveIntelligenceService({
        userId: ctx.userId!,
        workspaceId: ctx.workspaceId!,
        capability: "chat",
      });

      const workspace = await db.query.workspaces.findFirst({
        where: eq(workspaces.id, ctx.workspaceId!),
      });
      const settings = workspace?.settings as
        | { intelligenceServiceId?: string }
        | undefined;
      const serviceId = settings?.intelligenceServiceId;

      let manifest: {
        name: string;
        version?: string;
        capabilities: string[];
        endpoints?: string[];
        authType?: string;
      };

      if (serviceId) {
        const service = await db.query.intelligenceServices.findFirst({
          where: eq(intelligenceServices.serviceId, serviceId),
        });
        if (service) {
          manifest = {
            name: service.name,
            version: service.version ?? undefined,
            capabilities: (service.capabilities as string[]) ?? [],
            endpoints: (service.metadata as Record<string, unknown> | null)
              ?.endpoints as string[] | undefined,
            authType: (service.metadata as Record<string, unknown> | null)
              ?.authType as string | undefined,
          };
        } else {
          manifest = { name: serviceId, capabilities: [] };
        }
      } else {
        manifest =
          resolved.serviceId === "default"
            ? DEFAULT_SERVICE_MANIFEST
            : { name: resolved.serviceId, capabilities: [] };
      }

      const isDefaultService = resolved.serviceId === "default";
      const intelligenceConfigured = !isDefaultService;

      return {
        serviceId: resolved.serviceId,
        endpoint: resolved.endpoint,
        manifest,
        intelligenceConfigured,
      };
    }),

  // ── Specialisations Proxy ─────────────────────────────────────────────────

  /**
   * List specialisations from the connected intelligence service.
   * Proxies to hub GET /api/specialisations — gracefully returns [] if
   * the hub is unreachable (service not yet connected).
   * Used by the branch picker and Intelligence Studio Capabilities tab.
   */
  listSpecialisations: workspaceProcedure.query(async ({ ctx }) => {
    const userId = requireUserId(ctx.userId);
    try {
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const res = await apiProxyFetch("/specialisations", endpoint, apiKey);
      const data = (await res.json()) as { specialisations?: unknown[] };
      return {
        specialisations: Array.isArray(data.specialisations)
          ? data.specialisations
          : [],
      };
    } catch {
      return { specialisations: [] };
    }
  }),

  // ── Agent Definitions Proxy ───────────────────────────────────────────────

  /**
   * List agent definitions from the connected intelligence service.
   * Proxies to hub GET /api/agent-definitions — gracefully returns [] if
   * the hub is unreachable (service not yet connected).
   */
  agentDefinitions: workspaceProcedure.query(async ({ ctx }) => {
    const userId = requireUserId(ctx.userId);
    try {
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const res = await apiProxyFetch("/agent-definitions", endpoint, apiKey);
      const data = (await res.json()) as { agents?: unknown[] };
      return { agents: Array.isArray(data.agents) ? data.agents : [] };
    } catch {
      // Hub unreachable or no service configured — show empty state
      return { agents: [] };
    }
  }),

  // ── Memory Proxy ─────────────────────────────────────────────────────────

  /** List memory facts for current user */
  memoryFacts: workspaceProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(100) }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const params = new URLSearchParams({
        userId,
        limit: String(input.limit),
      });
      const res = await hubProxyFetch(`/memory?${params}`, endpoint, apiKey);
      const facts = await res.json();
      return { facts: Array.isArray(facts) ? facts : [] };
    }),

  /** Semantic search memory facts */
  searchMemory: workspaceProcedure
    .input(
      z.object({ query: z.string().min(1), limit: z.number().default(20) })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const res = await hubProxyFetch("/memory/search", endpoint, apiKey, {
        method: "POST",
        body: JSON.stringify({
          userId,
          query: input.query,
          limit: input.limit,
        }),
      });
      const facts = await res.json();
      return { facts: Array.isArray(facts) ? facts : [] };
    }),

  /** Create a memory fact */
  createMemoryFact: workspaceProcedure
    .input(
      z.object({
        fact: z.string().min(1),
        confidence: z.number().min(0).max(1).default(0.9),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const res = await hubProxyFetch("/memory", endpoint, apiKey, {
        method: "POST",
        body: JSON.stringify({
          userId,
          fact: input.fact,
          confidence: input.confidence,
        }),
      });
      const fact = await res.json();
      return { fact };
    }),

  /** Delete a memory fact */
  deleteMemoryFact: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      await hubProxyFetch(
        `/memory/${encodeURIComponent(input.id)}`,
        endpoint,
        apiKey,
        {
          method: "DELETE",
        }
      );
      return { success: true };
    }),

  // ── Executions Proxy ─────────────────────────────────────────────────────

  /** Get execution stats (24h summary) */
  executionStats: workspaceProcedure
    .input(z.object({ since: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      try {
        const { endpoint, apiKey } = await getServiceEndpoint(
          userId,
          ctx.workspaceId!
        );
        const params = input.since
          ? `?since=${encodeURIComponent(input.since)}`
          : "";
        const res = await apiProxyFetch(
          `/executions/stats${params}`,
          endpoint,
          apiKey
        );
        const data = (await res.json()) as { stats: ExecutionStats };
        return { stats: data.stats };
      } catch {
        return { stats: {} as ExecutionStats };
      }
    }),

  /** List executions with filters */
  executions: workspaceProcedure
    .input(
      z.object({
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().default(0),
        agentType: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const params = new URLSearchParams({
        limit: String(input.limit),
        offset: String(input.offset),
        userId,
      });
      if (input.agentType) params.set("agentType", input.agentType);
      const res = await apiProxyFetch(
        `/executions?${params}`,
        endpoint,
        apiKey
      );
      const data = (await res.json()) as { executions: ExecutionRecord[] };
      return { executions: data.executions };
    }),

  /** Get execution detail with tool logs */
  executionDetail: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const res = await apiProxyFetch(
        `/executions/${encodeURIComponent(input.id)}`,
        endpoint,
        apiKey
      );
      const data = (await res.json()) as {
        execution: ExecutionRecord;
        toolLogs: ToolLog[];
      };
      return data;
    }),

  // ── Proposals Proxy ──────────────────────────────────────────────────────

  /** List proposals with optional status filter */
  proposals: workspaceProcedure
    .input(
      z.object({
        status: z.enum(["pending", "approved", "denied"]).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const params = new URLSearchParams({ userId });
      if (input.status) params.set("status", input.status);
      const res = await hubProxyFetch(`/proposals?${params}`, endpoint, apiKey);
      const proposals = await res.json();
      return { proposals: Array.isArray(proposals) ? proposals : [] };
    }),

  /** Approve a proposal */
  approveProposal: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      await hubProxyFetch(
        `/proposals/${encodeURIComponent(input.id)}`,
        endpoint,
        apiKey,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "approved", userId }),
        }
      );
      return { success: true };
    }),

  /** Deny a proposal */
  denyProposal: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      await hubProxyFetch(
        `/proposals/${encodeURIComponent(input.id)}`,
        endpoint,
        apiKey,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "denied", userId }),
        }
      );
      return { success: true };
    }),

  // ── AI Channel Proxy ────────────────────────────────────────────────────

  // ── Service Management Relay ──────────────────────────────────────────────

  /**
   * Relay a management command to a registered intelligence service.
   *
   * Security model: tokens travel browser → backend (HTTPS + Kratos session)
   * → service (internal Docker network for cloud, direct HTTPS for self-hosted).
   * Tokens are never stored on Synap servers. If the service is unreachable the
   * command is stored as `metadata.pendingConfig` and replayed on reconnect.
   */
  relayToService: workspaceProcedure
    .input(
      z.object({
        serviceId: z.string().min(1),
        command: z.enum([
          "configure_channel",
          "install_skill",
          "list_channels",
        ]),
        payload: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      requireUserId(ctx.userId);
      // Support both exact match and slug-prefix match.
      // OpenClaw is registered as "openclaw-{userId}" but the frontend sends "openclaw".
      const service = await db.query.intelligenceServices.findFirst({
        where: or(
          eq(intelligenceServices.serviceId, input.serviceId),
          like(intelligenceServices.serviceId, `${input.serviceId}-%`)
        ),
      });
      if (!service || !service.enabled) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Intelligence service '${input.serviceId}' not found or not enabled`,
        });
      }
      const meta = (service.metadata ?? {}) as Record<string, unknown>;
      const managementUrl = `${service.webhookUrl.replace(/\/$/, "")}/api/management`;
      try {
        const res = await fetch(managementUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(typeof meta.managementToken === "string"
              ? { Authorization: `Bearer ${meta.managementToken}` }
              : {}),
          },
          body: JSON.stringify({
            command: input.command,
            payload: input.payload ?? {},
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => res.statusText);
          throw new TRPCError({
            code: "BAD_GATEWAY",
            message: `Service relay error (${res.status}): ${text}`,
          });
        }
        const data = await res.json().catch(() => ({ ok: true }));
        return { success: true, pending: false, data };
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        // Service unreachable — store as pending config; apply on next connect
        const pendingConfig = (meta.pendingConfig ?? {}) as Record<
          string,
          unknown
        >;
        const cmdKey = `${input.command}_${Date.now()}`;
        pendingConfig[cmdKey] = {
          ...(input.payload ?? {}),
          _pendingAt: new Date().toISOString(),
        };
        await db
          .update(intelligenceServices)
          .set({ metadata: { ...meta, pendingConfig } })
          .where(eq(intelligenceServices.serviceId, input.serviceId));
        return {
          success: true,
          pending: true,
          message: "Configuration saved — will apply when service reconnects",
        };
      }
    }),

  /** Start an AI-to-AI channel conversation */
  startAIChannel: workspaceProcedure
    .input(
      z.object({
        topic: z.string().min(1).max(500),
        mode: z
          .enum(["debate", "collaborate", "critique"])
          .default("collaborate"),
        maxTurns: z.number().int().min(1).max(5).default(3),
        personaA: z
          .object({
            name: z.string().default("Perspective A"),
            agentType: z.string().optional(),
            systemPrompt: z.string().optional(),
          })
          .default({ name: "Perspective A" }),
        personaB: z
          .object({
            name: z.string().default("Perspective B"),
            agentType: z.string().optional(),
            systemPrompt: z.string().optional(),
          })
          .default({ name: "Perspective B" }),
        initialMessage: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { endpoint, apiKey } = await getServiceEndpoint(
        userId,
        ctx.workspaceId!
      );
      const res = await apiProxyFetch("/ai-channel", endpoint, apiKey, {
        method: "POST",
        body: JSON.stringify({ userId, ...input }),
      });
      return res.json();
    }),

  /**
   * getServiceCommands
   *
   * Returns previously stored Docker run commands for provisioned services.
   * Allows wizards to show the command on re-open without regenerating credentials.
   */
  getServiceCommands: workspaceProcedure.query(async ({ ctx }) => {
    const workspaceId = ctx.workspaceId!;
    const [ws] = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const commands = (ws?.settings as Record<string, unknown> | null)
      ?.serviceCommands as Record<string, string> | undefined;
    return { commands: commands ?? {} };
  }),

  /**
   * provisionService
   *
   * Self-hosted equivalent of `./synap services add <serviceType>`.
   * Creates an agent user + Hub Protocol API key for the given service type,
   * and returns the Docker run command with credentials embedded.
   *
   * Called by the OpenClaw onboarding wizard instead of POST /openclaw/provision
   * (cloud path). The result is shown to the user as a copy-paste Docker command.
   * Once the container is started, it connects to the pod via Hub Protocol and
   * self-registers as an intelligence service.
   *
   * Idempotent: if the agent already exists, returns its ID without a new API key
   * (key is only shown once — user must rotate if lost).
   */
  provisionService: podProcedure
    .input(
      z.object({
        serviceType: z.enum(["openclaw"]),
        /** Override the pod URL embedded in the Docker run command. Defaults to PUBLIC_URL env var. */
        podUrlOverride: z.string().url().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { serviceType, podUrlOverride } = input;
      const workspaceId = ctx.workspaceId ?? null;

      // Pod-level: any authenticated user can provision (pod-level check done by podProcedure)
      const entry = SERVICE_CATALOG[serviceType];
      if (!entry) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown service type: ${serviceType}`,
        });
      }

      // Check if agent already exists (pod-wide search - no workspace membership required)
      const [existing] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.userType, "agent"),
            drizzleSql`${users.agentMetadata}->>'agentType' = ${serviceType}`
          )
        )
        .limit(1);

      const podUrl =
        podUrlOverride ?? process.env.PUBLIC_URL ?? "http://localhost:4000";

      if (existing) {
        // Idempotent — rotate key and return fresh docker command
        await db
          .update(apiKeys)
          .set({
            isActive: false,
            revokedAt: new Date(),
            revokedReason: "Re-provisioned via UI",
          })
          .where(
            and(eq(apiKeys.userId, existing.id), eq(apiKeys.isActive, true))
          );

        const keyPrefix =
          process.env.NODE_ENV === "production"
            ? "synap_hub_live_"
            : "synap_hub_test_";
        const plainKey = `${keyPrefix}${randomBytes(32).toString("hex")}`;

        const eventRepo = new EventRepository(sql);
        const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
        await apiKeyRepo.create(
          {
            keyName: `${entry.displayName} — rotated`,
            keyPrefix,
            key: plainKey,
            scope: entry.defaultScopes,
            userId: existing.id,
            keyType: "hub_inbound",
            description: `Hub Protocol auth token for ${entry.displayName} agent service.`,
          },
          ctx.userId ?? "system"
        );

        const dockerRunCommand =
          entry.buildDockerCommand?.({
            podUrl,
            workspaceId: workspaceId ?? "pod-wide",
            agentUserId: existing.id,
            apiKey: plainKey,
          }) ?? null;

        return {
          alreadyProvisioned: true,
          agentUserId: existing.id,
          dockerRunCommand,
          env: {
            SYNAP_POD_URL: podUrl,
            SYNAP_HUB_API_KEY: plainKey,
            SYNAP_WORKSPACE_ID: workspaceId ?? "pod-wide",
            SYNAP_AGENT_USER_ID: existing.id,
          },
        };
      }

      // Create new pod-wide agent user (no workspace membership required)
      const agentId = randomUUID();
      const shortId = agentId.slice(0, 8);
      const email = `agent-${serviceType}-${shortId}@synap.agent`;

      await db.insert(users).values({
        id: agentId,
        email,
        name: `${entry.displayName} Agent`,
        emailVerified: true,
        userType: "agent",
        agentMetadata: {
          agentType: serviceType,
          description: entry.description,
          createdByUserId: ctx.userId ?? "system",
          capabilities: entry.agentCapabilities,
        } satisfies AgentMetadata,
        kratosIdentityId: `agent:${agentId}`,
        timezone: "UTC",
        locale: "en",
      });

      const keyPrefix =
        process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_";
      const plainKey = `${keyPrefix}${randomBytes(32).toString("hex")}`;

      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
      await apiKeyRepo.create(
        {
          keyName: `${entry.displayName} — pod-wide`,
          keyPrefix,
          key: plainKey,
          scope: entry.defaultScopes,
          userId: agentId,
          keyType: "hub_inbound",
          description: `Hub Protocol auth token for ${entry.displayName} agent service. Used by the ${entry.displayName} Docker container to authenticate inbound API calls to this Synap backend.`,
        },
        ctx.userId ?? "system"
      );

      const dockerRunCommand =
        entry.buildDockerCommand?.({
          podUrl,
          workspaceId: workspaceId ?? "pod-wide",
          agentUserId: agentId,
          apiKey: plainKey,
        }) ?? null;

      return {
        alreadyProvisioned: false,
        agentUserId: agentId,
        dockerRunCommand,
        env: {
          SYNAP_POD_URL: podUrl,
          SYNAP_HUB_API_KEY: plainKey,
          SYNAP_WORKSPACE_ID: workspaceId ?? "pod-wide",
          SYNAP_AGENT_USER_ID: agentId,
        },
      };
    }),

  /**
   * provisionMcpService
   *
   * Provision an MCP-only tool service (not a Hub Protocol agent).
   * Currently supports: "firecrawl" — web scraping and content extraction.
   *
   * Unlike provisionService (which creates an agent user + Hub Protocol key),
   * this just:
   *   1. Creates an mcpServers row so the Intelligence Hub can connect to it
   *   2. Returns the Docker run command for the user to run locally
   *
   * The npx firecrawl-mcp stdio transport reads FIRECRAWL_API_URL at startup,
   * which points to the local Firecrawl Docker container on port 3002.
   *
   * Idempotent: calling again when already provisioned returns alreadyProvisioned=true
   * and the same Docker command (no credentials to rotate — public container).
   */
  provisionMcpService: workspaceProcedure
    .input(z.object({ serviceType: z.enum(["firecrawl"]) }))
    .mutation(async ({ ctx, input }) => {
      const { serviceType } = input;
      const workspaceId = ctx.workspaceId!;

      // Only workspace owners and admins can provision MCP services
      if (ctx.workspaceRole !== "owner" && ctx.workspaceRole !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only workspace owners and admins can provision MCP services.",
        });
      }

      if (serviceType === "firecrawl") {
        // Check idempotency — slug="firecrawl" is the stable key
        const existing = await db.query.mcpServers.findFirst({
          where: and(
            eq(mcpServers.slug, "firecrawl"),
            eq(mcpServers.workspaceId, workspaceId)
          ),
        });

        if (!existing) {
          // Register the firecrawl-mcp stdio server config.
          // The Intelligence Hub spawns `npx firecrawl-mcp` on demand,
          // pointing it at the local Firecrawl container via FIRECRAWL_API_URL.
          await db.insert(mcpServers).values({
            workspaceId,
            slug: "firecrawl",
            name: "Firecrawl",
            description:
              "Web scraping and content extraction — turns any URL into LLM-ready markdown, JSON, or structured data.",
            transport: "stdio",
            command: "npx",
            args: ["-y", "firecrawl-mcp@latest"],
            env: { FIRECRAWL_API_URL: "http://localhost:3002" },
            approved: true, // auto-approved: user explicitly provisioned this service
          });
          // Bust the cache so the next message picks up the new server immediately
          invalidateMcpCache(workspaceId);
        }

        const shortId = workspaceId.slice(0, 8);
        const dockerRunCommand = [
          "docker run -d",
          `  --name synap-firecrawl-${shortId}`,
          "  -p 3002:3002",
          "  ghcr.io/mendableai/firecrawl:latest",
        ].join(" \\\n");

        // Persist docker command in workspace settings so wizard can show it after re-open
        if (!existing) {
          await db
            .update(workspaces)
            .set({
              settings: drizzleSql`jsonb_set(coalesce(settings, '{}'), '{serviceCommands,firecrawl}', ${JSON.stringify(dockerRunCommand)}::jsonb, true)`,
            })
            .where(eq(workspaces.id, workspaceId));
        }

        // Fire-and-forget warmup ping: warms the Hub's MCP connection pool and
        // catches config issues early. Non-critical — result is ignored.
        if (!existing) {
          void resolveIntelligenceService({ userId: ctx.userId!, workspaceId })
            .then(({ endpoint: hubUrl, serviceApiKey: hubApiKey }) => {
              fetch(`${hubUrl}/api/mcp/ping`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-API-Key": hubApiKey,
                },
                body: JSON.stringify({
                  transport: "stdio",
                  command: "npx",
                  args: ["-y", "firecrawl-mcp@latest"],
                  env: { FIRECRAWL_API_URL: "http://localhost:3002" },
                }),
              }).catch(() => {
                // Hub may not be reachable — safe to ignore
              });
            })
            .catch(() => {});
        }

        return {
          alreadyProvisioned: !!existing,
          dockerRunCommand,
        };
      }

      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Unknown MCP service type: ${serviceType}`,
      });
    }),

  /**
   * getLatestMemoryState
   *
   * Returns the latest compacted memory state for the user's personal AI timeline.
   * Compacted states are written by any Hub Protocol service that implements the
   * session-scoped memory protocol (currently Synap Agent Hub).
   * Returns null if no state has been produced yet (new user or legacy service).
   */
  getLatestMemoryState: workspaceProcedure.query(async ({ ctx }) => {
    const userId = requireUserId(ctx.userId);

    const orchestratorId = await getAgentIdBySlug("orchestrator");
    if (!orchestratorId) return null;
    const personalChannel = await ensureAgentThread(userId, orchestratorId);

    const [state] = await db
      .select()
      .from(compactedStates)
      .where(eq(compactedStates.channelId, personalChannel.id))
      .orderBy(desc(compactedStates.version))
      .limit(1);

    if (!state) return null;

    return {
      id: state.id,
      version: state.version,
      compactionModel: state.compactionModel,
      createdAt: state.createdAt,
      blocks: {
        identity: state.identityBlock,
        userModel: state.userModelBlock,
        continuity: state.continuityBlock,
        activeGoals: state.activeGoalsBlock,
        entityContext: state.entityContextBlock,
      },
      metrics: {
        rawTokenCount: state.rawTokenCount,
        compressedTokenCount: state.compressedTokenCount,
        compressionRatio:
          state.rawTokenCount && state.compressedTokenCount
            ? Math.round(
                (1 - state.compressedTokenCount / state.rawTokenCount) * 100
              )
            : null,
      },
    };
  }),

  /**
   * getServiceManifest
   *
   * Returns the AgentManifest for the workspace's active IS.
   * For Synap IS (default): always fetches live from IS.
   * For custom IS: returns cached manifest from DB metadata, refreshes if stale (>1h).
   */
  getServiceManifest: workspaceProcedure.query(async ({ ctx }) => {
    const userId = requireUserId(ctx.userId);
    const workspaceId = ctx.workspaceId!;

    const { serviceId, endpoint, serviceApiKey } =
      await resolveIntelligenceService({
        userId,
        workspaceId,
      });

    const isSynapIS = serviceId === "default";

    // For custom IS: check metadata cache first (1h TTL)
    if (!isSynapIS) {
      const record = await db.query.intelligenceServices.findFirst({
        where: eq(intelligenceServices.serviceId, serviceId),
      });
      const meta = (record?.metadata ?? {}) as Record<string, unknown>;
      const cached = (meta.agentManifest as unknown) ?? null;
      const fetchedAt = meta.manifestFetchedAt as string | undefined;
      const isStale =
        !fetchedAt || Date.now() - new Date(fetchedAt).getTime() > 60 * 60_000;

      if (cached && !isStale) {
        return { manifest: cached, isSynapIS: false };
      }

      try {
        const res = await fetch(`${endpoint}/api/manifest`, {
          headers: { Authorization: `Bearer ${serviceApiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const manifest = (await res.json()) as unknown;
          const newMeta = {
            ...meta,
            agentManifest: manifest,
            manifestFetchedAt: new Date().toISOString(),
          };
          await db
            .update(intelligenceServices)
            .set({ metadata: newMeta })
            .where(eq(intelligenceServices.serviceId, serviceId));
          return { manifest, isSynapIS: false };
        }
      } catch {
        // IS unreachable — return cached or null
      }
      return { manifest: cached, isSynapIS: false };
    }

    // Synap IS: always fetch live (no hardcoded manifest)
    try {
      const res = await fetch(`${endpoint}/api/manifest`, {
        headers: { Authorization: `Bearer ${serviceApiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const manifest = (await res.json()) as unknown;
        return { manifest, isSynapIS: true };
      }
    } catch {
      // IS not reachable
    }
    return { manifest: null, isSynapIS: true };
  }),

  /**
   * listSystemSkills
   *
   * Returns the list of system skills served by the active IS.
   */
  listSystemSkills: workspaceProcedure.query(async ({ ctx }) => {
    const userId = requireUserId(ctx.userId);
    try {
      const { endpoint, serviceApiKey } = await resolveIntelligenceService({
        userId,
        workspaceId: ctx.workspaceId,
      });
      const res = await fetch(`${endpoint}/api/skills`, {
        headers: { Authorization: `Bearer ${serviceApiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = (await res.json()) as { skills?: unknown[] };
        return {
          skills: Array.isArray(data.skills) ? data.skills : [],
          source: "live" as const,
        };
      }
    } catch {
      // IS unreachable
    }
    return { skills: [], source: "offline" as const };
  }),

  /**
   * testCustomServiceConnection
   *
   * Tests connectivity to a candidate custom IS before registering.
   * Pings /api/capabilities (required) and /api/manifest (optional).
   */
  testCustomServiceConnection: workspaceProcedure
    .input(z.object({ hubUrl: z.string().url(), apiKey: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { hubUrl, apiKey } = input;

      let capabilities: string[] = [];
      let hasManifest = false;

      try {
        const capRes = await fetch(`${hubUrl}/api/capabilities`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!capRes.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Intelligence service returned ${capRes.status}. Check the URL and API key.`,
          });
        }
        const capData = (await capRes.json()) as { capabilities?: string[] };
        capabilities = Array.isArray(capData.capabilities)
          ? capData.capabilities
          : [];
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Could not reach ${hubUrl}. Make sure the service is running and the URL is correct.`,
        });
      }

      try {
        const mfRes = await fetch(`${hubUrl}/api/manifest`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        hasManifest = mfRes.ok;
      } catch {
        // manifest is optional
      }

      return { ok: true, capabilities, hasManifest };
    }),

  /**
   * registerCustomService
   *
   * Registers a custom IS endpoint for the workspace.
   * Does NOT auto-activate — use setActiveService to make it active.
   */
  registerCustomService: workspaceProcedure
    .input(
      z.object({
        displayName: z.string().min(1).max(80),
        hubUrl: z.string().url(),
        apiKey: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { displayName, hubUrl, apiKey } = input;

      if (ctx.workspaceRole !== "owner" && ctx.workspaceRole !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only workspace owners and admins can register AI services.",
        });
      }

      // Fetch capabilities to verify connectivity
      let capabilities: string[] = [];
      try {
        const capRes = await fetch(`${hubUrl}/api/capabilities`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!capRes.ok) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Service returned ${capRes.status}. Verify the URL and API key.`,
          });
        }
        const data = (await capRes.json()) as { capabilities?: string[] };
        capabilities = Array.isArray(data.capabilities)
          ? data.capabilities
          : [];
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Could not reach the service. Make sure it is running.",
        });
      }

      // Try fetching manifest (soft-fail)
      let agentManifest: unknown = null;
      try {
        const mfRes = await fetch(`${hubUrl}/api/manifest`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        });
        if (mfRes.ok) agentManifest = await mfRes.json();
      } catch {
        // optional
      }

      // Generate a stable service ID from display name
      const slug = displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const serviceId = `custom-${slug}-${randomUUID().slice(0, 8)}`;
      const id = randomUUID();

      await db.insert(intelligenceServices).values({
        id,
        serviceId,
        name: displayName,
        webhookUrl: hubUrl,
        apiKey,
        capabilities,
        metadata: agentManifest
          ? {
              agentManifest,
              manifestFetchedAt: new Date().toISOString(),
            }
          : {},
      });

      return { serviceId, id, displayName };
    }),

  /**
   * setActiveService
   *
   * Makes the given serviceId the active IS for the workspace.
   * Use "default" to switch back to Synap Agent.
   */
  setActiveService: workspaceProcedure
    .input(z.object({ serviceId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const workspaceId = ctx.workspaceId!;

      if (ctx.workspaceRole !== "owner" && ctx.workspaceRole !== "admin") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Only workspace owners and admins can change the active AI service.",
        });
      }

      if (input.serviceId !== "default") {
        const record = await db.query.intelligenceServices.findFirst({
          where: eq(intelligenceServices.serviceId, input.serviceId),
        });
        if (!record) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Intelligence service not found.",
          });
        }
      }

      await db
        .update(workspaces)
        .set({
          settings: drizzleSql`jsonb_set(coalesce(settings, '{}'), '{intelligenceServiceId}', ${JSON.stringify(input.serviceId)}::jsonb, true)`,
        })
        .where(eq(workspaces.id, workspaceId));

      return { serviceId: input.serviceId };
    }),

  /**
   * listRegisteredServices
   *
   * Returns all IS records registered for the workspace.
   * apiKey is never returned.
   */
  listRegisteredServices: workspaceProcedure.query(async () => {
    const records = await db.query.intelligenceServices.findMany({
      columns: {
        apiKey: false, // never expose
      },
    });
    return { services: records };
  }),

  /**
   * extractEntity
   *
   * Uses the Intelligence Service to extract structured entity data from a web page.
   * Called by the browser Save button's AI extraction strategy.
   * Returns null on failure — callers fall back to the simple IPC strategy.
   */
  extractEntity: workspaceProcedure
    .input(
      z.object({
        url: z.string().url(),
        html: z.string().max(50_000),
        title: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: ctx.workspaceId,
        capability: "default",
      });
      const result = await client.structure({
        text: input.title || input.url,
        url: input.url,
        html: input.html,
      });
      if (!result?.entities?.length) return null;
      const e = result.entities[0];
      return {
        profileSlug: e.profileSlug,
        title: e.title,
        description: e.description,
        properties: e.properties ?? {},
        confidence: e.confidence,
      };
    }),

  /**
   * classifyCapture
   *
   * Classifies raw text/URL into a structured entity type using the IS.
   * Works for authenticated users — anonymous users use the IPC bridge instead.
   * Falls back gracefully — returns null if IS is unavailable.
   */
  classifyCapture: workspaceProcedure
    .input(
      z.object({
        text: z.string().min(1).max(4000),
        url: z.string().url().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { client } = await resolveIntelligenceService({
        userId,
        workspaceId: ctx.workspaceId,
        capability: "default",
      });
      const result = await client.structure({
        text: input.text,
        url: input.url,
      });
      if (!result?.entities?.length) return null;
      const e = result.entities[0];
      return {
        profileSlug: e.profileSlug,
        title: e.title,
        properties: e.properties ?? {},
        confidence: e.confidence,
        tokensUsed: 0,
      };
    }),
});
