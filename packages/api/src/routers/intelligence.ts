/**
 * Intelligence Router
 *
 * Commands (Raycast-style), runs (audit), effective service (manifest),
 * and proxy procedures for intelligence service management APIs
 * (agents, tools, memory, skills, executions, proposals).
 */

import { z } from "zod";
import { router, workspaceProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { db, eq, and, desc } from "@synap/database";
import {
  intelligenceCommands,
  commandRuns,
  channels,
  ChannelType,
  ChannelStatus,
  ChannelAgentType,
  intelligenceServices,
  type NewIntelligenceCommand,
} from "@synap/database/schema";
import { workspaces } from "@synap/database/schema";
import {
  parseCommandTemplate,
  validateArgumentValues,
  type SelectionContext,
} from "../utils/command-template.js";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { requireUserId } from "../utils/user-scoped.js";
import { channelsRouter } from "./channels.js";

// ── Intelligence Service Proxy Helpers ─────────────────────────────────────

/** Fetch from the intelligence service Hub API (e.g. /api/hub/memory) */
async function hubProxyFetch(
  endpoint: string,
  serviceUrl: string,
  options: RequestInit = {}
): Promise<Response> {
  const url = `${serviceUrl}/api/hub${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.INTELLIGENCE_HUB_API_KEY || "",
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
  options: RequestInit = {}
): Promise<Response> {
  const url = `${serviceUrl}/api${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.INTELLIGENCE_HUB_API_KEY || "",
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

/** Resolve the intelligence service endpoint URL for the current workspace */
async function getServiceEndpoint(
  userId: string,
  workspaceId: string
): Promise<string> {
  const resolved = await resolveIntelligenceService({
    userId,
    workspaceId,
    capability: "chat",
  });
  return resolved.endpoint;
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
        argumentValues: z.record(z.string(), z.string()),
        selectionContext: selectionContextSchema.optional(),
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

      const { substitute } = parseCommandTemplate(cmd.promptTemplate);
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

      const compiledPrompt = substitute(
        input.argumentValues,
        input.selectionContext as SelectionContext | undefined
      );

      const [thread] = await db
        .insert(channels)
        .values({
          userId,
          workspaceId,
          channelType: ChannelType.AI_THREAD,
          status: ChannelStatus.ACTIVE,
          agentId: "orchestrator",
          agentType: ChannelAgentType.DEFAULT,
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
        } as any)
        .returning();
      if (!run) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      try {
        const chatCaller = channelsRouter.createCaller(ctx as any);
        await chatCaller.sendMessage({
          threadId: thread.id,
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
            endpoints: (service.metadata as any)?.endpoints,
            authType: (service.metadata as any)?.authType,
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
      const intelligenceConfigured =
        !isDefaultService ||
        Boolean(
          process.env.INTELLIGENCE_HUB_API_KEY?.trim() ||
          process.env.HUB_PROTOCOL_API_KEY?.trim()
        );

      return {
        serviceId: resolved.serviceId,
        endpoint: resolved.endpoint,
        manifest,
        intelligenceConfigured,
      };
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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const res = await apiProxyFetch("/agent-definitions", endpoint);
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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const params = new URLSearchParams({
        userId,
        limit: String(input.limit),
      });
      const res = await hubProxyFetch(`/memory?${params}`, endpoint);
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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const res = await hubProxyFetch("/memory/search", endpoint, {
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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const res = await hubProxyFetch("/memory", endpoint, {
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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      await hubProxyFetch(`/memory/${encodeURIComponent(input.id)}`, endpoint, {
        method: "DELETE",
      });
      return { success: true };
    }),

  // ── Executions Proxy ─────────────────────────────────────────────────────

  /** Get execution stats (24h summary) */
  executionStats: workspaceProcedure
    .input(z.object({ since: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const params = input.since
        ? `?since=${encodeURIComponent(input.since)}`
        : "";
      const res = await apiProxyFetch(`/executions/stats${params}`, endpoint);
      const data = (await res.json()) as { stats: unknown };
      return { stats: data.stats };
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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const params = new URLSearchParams({
        limit: String(input.limit),
        offset: String(input.offset),
        userId,
      });
      if (input.agentType) params.set("agentType", input.agentType);
      const res = await apiProxyFetch(`/executions?${params}`, endpoint);
      const data = (await res.json()) as { executions: unknown[] };
      return { executions: data.executions };
    }),

  /** Get execution detail with tool logs */
  executionDetail: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const res = await apiProxyFetch(
        `/executions/${encodeURIComponent(input.id)}`,
        endpoint
      );
      const data = (await res.json()) as {
        execution: unknown;
        toolLogs: unknown[];
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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const params = new URLSearchParams({ userId });
      if (input.status) params.set("status", input.status);
      const res = await hubProxyFetch(`/proposals?${params}`, endpoint);
      const proposals = await res.json();
      return { proposals: Array.isArray(proposals) ? proposals : [] };
    }),

  /** Approve a proposal */
  approveProposal: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      await hubProxyFetch(
        `/proposals/${encodeURIComponent(input.id)}`,
        endpoint,
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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      await hubProxyFetch(
        `/proposals/${encodeURIComponent(input.id)}`,
        endpoint,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "denied", userId }),
        }
      );
      return { success: true };
    }),

  // ── AI Channel Proxy ────────────────────────────────────────────────────

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
      const endpoint = await getServiceEndpoint(userId, ctx.workspaceId!);
      const res = await apiProxyFetch("/ai-channel", endpoint, {
        method: "POST",
        body: JSON.stringify({ userId, ...input }),
      });
      return res.json();
    }),
});
