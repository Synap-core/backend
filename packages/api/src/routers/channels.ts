/**
 * Channels Router - tRPC routes for channels (conversations) with branching
 *
 * Handles:
 * - Channel management (channels table, was chat_threads)
 * - Message sending/receiving with Intelligence Hub
 * - Entity extraction
 * - Branching logic
 * - Context tracking via channel_context_items
 */

import { z } from "zod";
import { router, protectedProcedure, workspaceProcedure } from "../trpc.js";
import { aiRateLimitMiddleware } from "../middleware/ai-rate-limit.js";
import {
  resolveAgentHandle,
  extractMentionAgentType,
} from "../utils/agent-handles.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  desc,
  and,
  or,
  lt,
  gte,
  inArray,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  channels,
  messages,
  channelContextItems,
  entities as entitiesTable,
  ChannelType,
  ThreadKind,
  FeedScope,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  type ChannelContextObjectType,
  ChannelContextRelationshipType,
  proposals,
  ProposalStatus,
  users,
  workspaceMembers,
  workspaces,
  mcpServers,
  sessions,
  SessionStatus,
  agents,
  sourceConfigs,
  sourceSubscriptions,
} from "@synap/database/schema";
import {
  resolveIntelligenceService,
  resolveIntelligenceServiceByAgentId,
} from "../utils/intelligence-routing.js";
import { validateExternalUrl } from "../utils/validate-url.js";
import { resolveAiChannelByFamily } from "../utils/resolve-ai-channel-family.js";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { MessageLinksRepository } from "@synap/database";
import {
  MessageLinkTargetType,
  MessageLinkRelationshipType,
  AI_CHANNEL_FAMILY_VALUES,
} from "@synap-core/types";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import type { AIStep, HubResponse } from "@synap-core/types";
import type { Channel } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { emitSideEffects, getBoss } from "@synap/events";
import { AgentRepository } from "@synap/database";
import { resolveVaultReferences } from "../utils/vault-resolver.js";

const logger = createLogger({ module: "channels" });

/** A concrete fetch target produced by the CP query planner. */
export interface DerivedQuery {
  upstreamType: string;
  config: Record<string, unknown>;
  label: string;
  rationale?: string;
}

/**
 * Ask the CP relay to expand archetype + criteria into concrete DerivedQuery[].
 * Best-effort: returns [] on any error so setupFeed can proceed unblocked.
 */
async function deriveFeedQueries(
  archetypeConfig: { config: unknown; userId: string },
  archetype: string,
  criteria: string | undefined
): Promise<DerivedQuery[]> {
  try {
    const raw = (archetypeConfig.config ?? {}) as Record<string, unknown>;
    // Fall back to env vars — source_config rows don't always bake in the CP URL.
    const relayUrl =
      (raw.relayUrl as string | undefined) ??
      process.env.CP_URL ??
      process.env.CONTROL_PLANE_URL;
    const relayKeyRef =
      (raw.relayKey as string | undefined) ??
      process.env.CP_RELAY_KEY ??
      process.env.SOURCE_RELAY_KEY;
    if (!relayUrl || !relayKeyRef) return [];

    const resolved = await resolveVaultReferences(
      { relayKey: relayKeyRef },
      archetypeConfig.userId
    );
    const relayKey = resolved.relayKey;
    if (!relayKey) return [];

    const res = await fetch(
      `${relayUrl.replace(/\/$/, "")}/api/sources/plan-queries`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${relayKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ archetype, criteria }),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      logger.warn(
        { archetype, status: res.status },
        "plan-queries returned non-OK — skipping derived queries"
      );
      return [];
    }

    const json = (await res.json()) as unknown;
    if (
      !json ||
      typeof json !== "object" ||
      !Array.isArray((json as { queries?: unknown }).queries)
    ) {
      return [];
    }
    return (json as { queries: DerivedQuery[] }).queries;
  } catch (err) {
    logger.warn(
      { err, archetype },
      "Failed to derive feed queries (non-fatal)"
    );
    return [];
  }
}

const CHANNEL_TYPE_VALUES = [
  ChannelType.THREAD,
  ChannelType.FEED,
  ChannelType.EXTERNAL,
  ChannelType.AGENT_COLLAB,
] as const;

const THREAD_KIND_VALUES = [
  ThreadKind.PERSONAL,
  ThreadKind.WORKSPACE,
  ThreadKind.ENTITY,
  ThreadKind.DOCUMENT,
  ThreadKind.VIEW,
  ThreadKind.PROJECT,
  ThreadKind.TASK,
  ThreadKind.BRANCH,
] as const;

const CONTEXT_OBJECT_TYPE_VALUES = ["entity", "document", "view"] as const;

// ── MCP server list cache ────────────────────────────────────────────────────
// Avoid a DB query on every message send. TTL = 30s (short enough to pick up
// newly provisioned servers quickly; long enough to handle bursts).

interface McpServerEntry {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
}

const MCP_CACHE_TTL_MS = 30_000;
const mcpServerCache = new Map<
  string,
  { servers: McpServerEntry[]; expiresAt: number }
>();

const POD_WIDE_MCP_CACHE_KEY = "__pod_wide__";

export function invalidateMcpCache(workspaceId?: string | null): void {
  mcpServerCache.delete(workspaceId ?? POD_WIDE_MCP_CACHE_KEY);
}

/**
 * Resolve an agentId for message sending.
 * If a valid UUID is passed, validate it exists + active in the agents table.
 * Otherwise falls back to the orchestrator agent.
 * Throws if neither is found — a missing orchestrator means agent sync hasn't run.
 */
async function resolveAgentId(agentId?: string): Promise<string> {
  // Validate the provided UUID format
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (agentId && !UUID_RE.test(agentId)) {
    logger.warn(
      { agentId },
      "Invalid agentId UUID format, falling back to orchestrator"
    );
    agentId = undefined;
  }

  if (agentId) {
    const agentRepo = new AgentRepository(db);
    const agent = await agentRepo.getById(agentId);
    if (agent?.active) return agent.id;
    logger.warn(
      { agentId },
      "Agent not found or inactive, falling back to orchestrator"
    );
  }

  // Fall back to the orchestrator agent
  const [orchestrator] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
    .limit(1);

  if (!orchestrator) {
    throw new Error(
      "Orchestrator agent not found in agents table. Run agent sync (POST /api/hub/agents/sync) to populate."
    );
  }
  return orchestrator.id;
}

async function getMcpServersForWorkspace(
  workspaceId: string
): Promise<McpServerEntry[]> {
  const cached = mcpServerCache.get(workspaceId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.servers;
  }
  const rows = await db.query.mcpServers.findMany({
    where: and(
      eq(mcpServers.workspaceId, workspaceId),
      eq(mcpServers.approved, true),
      eq(mcpServers.enabled, true)
    ),
  });
  const servers: McpServerEntry[] = rows
    .filter((r) => r.transport === "stdio" || r.transport === "http")
    .map((r) => ({
      id: r.slug,
      name: r.name,
      transport: r.transport as "stdio" | "http",
      command: r.command ?? undefined,
      args: r.args,
      url: r.url ?? undefined,
      env: r.env,
      enabled: r.enabled,
    }));
  mcpServerCache.set(workspaceId, {
    servers,
    expiresAt: Date.now() + MCP_CACHE_TTL_MS,
  });
  return servers;
}

/**
 * Ensure a pod-wide personal AI agent user exists for this human.
 * One agent user is shared across all workspaces — it accumulates memory
 * and identity pod-wide rather than being fragmented per workspace.
 *
 * Flow:
 *   1. Look up by createdByUserId + isPersonalAgent (pod-wide, no workspace filter).
 *   2. If found: ensure membership in the current workspace if absent.
 *   3. If not found: create the agent user, then add membership.
 *
 * Role: "owner" in agent-governed workspaces (governanceMode='agent-owned'),
 *       "editor" in all other workspaces.
 */
async function ensureAgentUser(
  userId: string,
  workspaceId: string
): Promise<string> {
  // 1. Find existing pod-wide personal agent (no workspace filter)
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.userType, "agent"),
        drizzleSql`${users.agentMetadata}->>'createdByUserId' = ${userId}`,
        drizzleSql`${users.agentMetadata}->>'isPersonalAgent' = 'true'`
      )
    )
    .limit(1);

  let resolvedAgentId: string;

  if (!existing) {
    // 2a. Create the pod-wide personal agent user
    const newId = randomUUID();
    const shortId = newId.slice(0, 8);
    const [agentUser] = await db
      .insert(users)
      .values({
        id: newId,
        email: `agent-orchestrator-${shortId}@synap.agent`,
        userType: "agent",
        kratosIdentityId: null,
        agentMetadata: {
          createdByUserId: userId,
          agentType: "orchestrator",
          isPersonalAgent: true,
        },
      })
      .returning({ id: users.id });
    resolvedAgentId = agentUser.id;
  } else {
    resolvedAgentId = existing.id;
  }

  // 2b. Ensure workspace membership (idempotent)
  const [existingMembership] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, resolvedAgentId),
        eq(workspaceMembers.workspaceId, workspaceId)
      )
    )
    .limit(1);

  if (!existingMembership) {
    // Agent is owner in agent-governed workspaces, editor elsewhere
    const [ws] = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    const wsSettings = ws?.settings as { governanceMode?: string } | undefined;
    const role =
      wsSettings?.governanceMode === "agent-owned" ? "owner" : "editor";

    await db.insert(workspaceMembers).values({
      id: randomUUID(),
      workspaceId,
      userId: resolvedAgentId,
      role,
    });
  }

  return resolvedAgentId;
}

/**
 * Relay the Synap AI's response to an external platform (Telegram, WhatsApp, etc.)
 * via the registered OpenClaw intelligence service.
 *
 * Uses the `channels` capability to find the service that handles external messaging.
 * If no such service is registered (no OpenClaw), this is a silent no-op.
 *
 * OpenClaw expects an OpenAI-compatible POST to `/v1/chat/completions` with an
 * `x-openclaw-session-key` header containing the platform's native channel ID.
 * It routes the content to the correct platform + contact automatically.
 */
async function relayToExternalChannel(opts: {
  workspaceId: string | undefined;
  userId: string;
  externalSource: string;
  externalChannelId: string;
  content: string;
}): Promise<void> {
  const { workspaceId, userId, externalSource, externalChannelId, content } =
    opts;

  let service: Awaited<ReturnType<typeof resolveIntelligenceService>>;
  try {
    service = await resolveIntelligenceService({
      userId,
      workspaceId,
      capability: "channels", // routes to OpenClaw/ZeroClaw which have "channels" capability
    });
  } catch {
    return; // no service registered for channels capability — silent no-op
  }

  // Only relay if the resolved service is NOT the default Intelligence Hub
  // (which can't receive external relay calls)
  if (service.serviceId === "default" || !service.endpoint) return;

  // SSRF guard: validate the service endpoint before fetching
  const urlCheck = validateExternalUrl(service.endpoint);
  if (!urlCheck.valid) {
    console.warn(
      "[channels] Blocked relay to potentially unsafe endpoint:",
      service.endpoint,
      urlCheck.reason
    );
    return;
  }

  await fetch(`${service.endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-openclaw-session-key": externalChannelId,
      "x-openclaw-platform": externalSource,
    },
    body: JSON.stringify({
      model: "synap-relay",
      messages: [{ role: "assistant", content }],
      stream: false,
    }),
    signal: AbortSignal.timeout(15000),
  });
}

/**
 * Node shape for the workspace branch tree response.
 * Defined at module scope so tsc can include it in declaration output.
 */
export type BranchNodeResult = {
  channel: Channel;
  children: BranchNodeResult[];
  messageCount: number;
  lastActivity: Date;
  depth: number;
};

/**
 * Channels Router
 *
 * Registered under the `chat` tRPC key for frontend compatibility.
 */
async function listChannelsWithFlags(params: {
  userId: string;
  workspaceId?: string;
  channelType?: (typeof CHANNEL_TYPE_VALUES)[number];
  threadKind?: (typeof THREAD_KIND_VALUES)[number];
  feedScope?: FeedScope;
  contextObjectId?: string;
  contextObjectType?: (typeof CONTEXT_OBJECT_TYPE_VALUES)[number];
  assignedAgentId?: string;
  limit: number;
  offset?: number;
}): Promise<
  Array<
    Channel & {
      hasAssistantMessage: boolean;
      origin: string;
    }
  >
> {
  const conditions: any[] = [eq(channels.userId, params.userId)];

  if (params.workspaceId !== undefined) {
    // Include workspace channels + pod-wide channels (personal-style thread + feed)
    conditions.push(
      or(
        eq(channels.workspaceId, params.workspaceId),
        and(
          eq(channels.channelType, ChannelType.THREAD),
          eq(channels.threadKind, ThreadKind.PERSONAL)
        ),
        eq(channels.channelType, ChannelType.FEED)
      )!
    );
  }

  if (params.channelType) {
    conditions.push(eq(channels.channelType, params.channelType));
  }

  if (params.threadKind) {
    conditions.push(eq(channels.threadKind, params.threadKind));
  }

  if (params.feedScope) {
    conditions.push(eq(channels.feedScope, params.feedScope));
  }

  if (params.contextObjectId !== undefined) {
    conditions.push(eq(channels.contextObjectId, params.contextObjectId));
  }

  if (params.contextObjectType !== undefined) {
    conditions.push(eq(channels.contextObjectType, params.contextObjectType));
  }

  if (params.assignedAgentId) {
    conditions.push(eq(channels.assignedAgentId, params.assignedAgentId));
  }

  const rows = await db.query.channels.findMany({
    where: and(...conditions),
    orderBy: [desc(channels.updatedAt)],
    limit: params.limit,
    offset: params.offset,
  });

  if (rows.length === 0) {
    return [];
  }

  const channelIds = rows.map((c) => c.id);
  const rowsWithAssistant = await db
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(
      and(
        inArray(messages.channelId, channelIds),
        eq(messages.role, MessageRole.ASSISTANT)
      )
    );
  const channelIdsWithAssistant = new Set(
    rowsWithAssistant.map((r) => r.channelId)
  );

  return rows.map((c) => ({
    ...c,
    hasAssistantMessage: channelIdsWithAssistant.has(c.id),
    origin: (c.metadata as { origin?: string } | null)?.origin ?? "chat",
  }));
}

export const channelsRouter = router({
  /**
   * Resolve AI channel by structural family.
   */
  resolveAiChannel: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        family: z.enum(AI_CHANNEL_FAMILY_VALUES).default("agent"),
        contextObjectId: z.string().uuid().optional(),
        contextObjectType: z.enum(CONTEXT_OBJECT_TYPE_VALUES).optional(),
        parentChannelId: z.string().uuid().optional(),
        branchPurpose: z.string().max(500).optional(),
        /** Agent slug to assign when creating the channel (e.g. "networking"). */
        agentSlug: z.string().max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const channel = await resolveAiChannelByFamily({
        userId: ctx.userId,
        workspaceId: input.workspaceId ?? ctx.workspaceId ?? undefined,
        family: input.family,
        contextObjectId: input.contextObjectId,
        contextObjectType: input.contextObjectType,
        parentChannelId: input.parentChannelId,
        branchPurpose: input.branchPurpose,
        agentSlug: input.agentSlug,
      });
      return { channel };
    }),

  /**
   * Create a new channel.
   * When parentChannelId is provided, creates a branch channel.
   */
  createChannel: workspaceProcedure
    .input(
      z.object({
        parentChannelId: z.string().uuid().optional(),
        branchPurpose: z.string().optional(),
        /** UUID of the agent to assign to this channel (from agents table). */
        agentId: z.string().uuid().optional(),
        /** Slug of the agent to assign (e.g. "orchestrator", "networking"). Resolved to UUID server-side. */
        agentSlug: z.string().max(100).optional(),
        agentConfig: z.record(z.string(), z.any()).optional(),
        inheritContext: z.boolean().default(true),
        title: z.string().optional(),
        externalSource: z.string().optional(),
        externalChannelId: z.string().optional(),
        externalParticipants: z.array(z.string()).optional(),
        metadata: z.record(z.string(), z.any()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = ctx.workspaceId;

      // If branching, verify parent channel is in same workspace
      if (input.parentChannelId) {
        const parentChannel = await db.query.channels.findFirst({
          where: eq(channels.id, input.parentChannelId),
        });

        if (!parentChannel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Parent channel not found",
          });
        }
      }

      // Branch channel
      if (input.parentChannelId) {
        const branchChannelId = randomUUID();

        const [branchChannel] = await db
          .insert(channels)
          .values({
            id: branchChannelId,
            userId: ctx.userId,
            workspaceId: workspaceId ?? null,
            parentChannelId: input.parentChannelId,
            branchPurpose: input.branchPurpose,
            agentConfig: input.agentConfig,
            channelType: ChannelType.THREAD,
            threadKind: ThreadKind.BRANCH,
            status: ChannelStatus.ACTIVE,
          })
          .returning();

        emitChatEvent({
          event: "channel:created",
          data: {
            channelId: branchChannelId,
            userId: ctx.userId,
            parentChannelId: input.parentChannelId,
          },
          workspaceId: workspaceId ?? null,
          userId: ctx.userId,
        });

        return { channelId: branchChannelId, channel: branchChannel };
      }

      // Main AI channel
      const channelId = randomUUID();

      // Validate the requested agentId exists and is active.
      // Leave assignedAgentId null if no agentId provided — IS must sync agents first.
      let assignedAgentId: string | undefined;
      if (input.agentId) {
        const agentRepo = new AgentRepository(db);
        const agent = await agentRepo.getById(input.agentId);
        if (agent?.active) {
          assignedAgentId = agent.id;
        } else {
          logger.warn(
            { agentId: input.agentId },
            "Requested agentId not found or inactive — channel created without agent"
          );
        }
      }

      // If no agentId but agentSlug provided, resolve slug → UUID
      if (!assignedAgentId && input.agentSlug) {
        const [agentBySlug] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.slug, input.agentSlug), eq(agents.active, true)))
          .limit(1);
        if (agentBySlug) {
          assignedAgentId = agentBySlug.id;
        } else {
          logger.warn(
            { agentSlug: input.agentSlug },
            "Agent slug not found — channel created without agent"
          );
        }
      }

      await db
        .insert(channels)
        .values({
          id: channelId,
          userId: ctx.userId,
          workspaceId: workspaceId ?? null,
          channelType: ChannelType.THREAD,
          threadKind: ThreadKind.PERSONAL,
          status: ChannelStatus.ACTIVE,
          assignedAgentId: assignedAgentId ?? null,
          title: input.title,
          externalSource: input.externalSource,
          externalChannelId: input.externalChannelId,
          metadata: {
            externalParticipants: input.externalParticipants ?? [],
            // External reply routing is capability + toggle based and only runs
            // when the connector marks the conversation as live.
            relayEnabled: false,
            connectorLive: false,
            ...(input.metadata ?? {}),
          },
        })
        .returning();

      emitChatEvent({
        event: "channel:created",
        data: {
          channelId,
          userId: ctx.userId,
          externalSource: input.externalSource,
        },
        workspaceId,
        userId: ctx.userId,
      });

      return { channelId, status: "created" as const };
    }),

  /**
   * Create an agent_collab channel (internal multi-agent collaboration).
   *
   * A persistent async channel where multiple AI agents (and optionally human
   * observers) communicate. Distinct from Google A2A (ephemeral, cross-system).
   *
   * Visibility:
   *   "closed" — only named participants (agent user IDs) can post
   *   "open"   — discoverable by any agent; first post from a new agent triggers
   *              a lightweight proposal so the user can approve/deny the new participant
   *
   * Humans can observe and inject messages at any time.
   */
  createAgentCollabChannel: workspaceProcedure
    .input(
      z.object({
        topic: z.string().min(1).max(500),
        visibility: z.enum(["open", "closed"]).default("closed"),
        /** Agent user IDs that can post (required for closed, recommended for open) */
        participants: z.array(z.string().uuid()).optional(),
        title: z.string().max(255).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace context required",
        });
      }

      // Restricted for now: only workspace admin/owner can create agent_collab channels.
      if (!["admin", "owner"].includes(ctx.workspaceRole ?? "")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Admin or owner role required to create agent_collab channels",
        });
      }

      const channelId = randomUUID();
      await db.insert(channels).values({
        id: channelId,
        userId: ctx.userId,
        workspaceId,
        channelType: ChannelType.AGENT_COLLAB,
        status: ChannelStatus.ACTIVE,
        title: input.title ?? input.topic.slice(0, 80),
        metadata: {
          topic: input.topic,
          visibility: input.visibility,
          participants: input.participants ?? [],
          a2aiStatus: "active",
        },
      });

      emitChatEvent({
        event: "channel:created",
        data: {
          channelId,
          userId: ctx.userId,
          channelType: ChannelType.AGENT_COLLAB,
        },
        workspaceId,
        userId: ctx.userId,
      });

      return { channelId, status: "created" as const };
    }),

  /**
   * Create a document comment: new channel with one user message linked to the
   * document at the given selection. No AI response.
   */
  createDocumentComment: workspaceProcedure
    .input(
      z.object({
        documentId: z.string().uuid(),
        position: z.object({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
        }),
        content: z.string().min(1).max(50_000),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace context required",
        });
      }

      const channelId = randomUUID();
      const userMessageId = randomUUID();
      const userMessageHash = createHash("sha256")
        .update(`${userMessageId}${input.content}`)
        .digest("hex");

      await db.insert(channels).values({
        id: channelId,
        userId: ctx.userId,
        workspaceId,
        channelType: ChannelType.THREAD,
        contextObjectType: "document",
        contextObjectId: input.documentId,
        status: ChannelStatus.ACTIVE,
        metadata: { origin: "comment" },
      });

      await db.insert(messages).values({
        id: userMessageId,
        channelId,
        role: MessageRole.USER,
        content: input.content,
        userId: ctx.userId,
        previousHash: "",
        hash: userMessageHash,
      });

      const linksRepo = new MessageLinksRepository(db);
      await linksRepo.create({
        messageId: userMessageId,
        targetType: MessageLinkTargetType.DOCUMENT,
        targetId: input.documentId,
        relationshipType: MessageLinkRelationshipType.COMMENTS,
        position: input.position,
        userId: ctx.userId,
        workspaceId,
      });

      emitChatEvent({
        event: "channel:created",
        data: { channelId, userId: ctx.userId },
        workspaceId,
        userId: ctx.userId,
      });

      return { channelId, messageId: userMessageId };
    }),

  /**
   * Create an entity comment: new channel with one user message linked to the entity.
   * No AI response. Used when user sends a message from the entity panel Messages tab.
   */
  createEntityComment: workspaceProcedure
    .input(
      z.object({
        entityId: z.string().uuid(),
        content: z.string().min(1).max(50_000),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = ctx.workspaceId;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Workspace context required",
        });
      }

      const channelId = randomUUID();
      const userMessageId = randomUUID();
      const userMessageHash = createHash("sha256")
        .update(`${userMessageId}${input.content}`)
        .digest("hex");

      await db.insert(channels).values({
        id: channelId,
        userId: ctx.userId,
        workspaceId,
        channelType: ChannelType.THREAD,
        contextObjectType: "entity",
        contextObjectId: input.entityId,
        status: ChannelStatus.ACTIVE,
        metadata: { origin: "comment" },
      });

      await db.insert(messages).values({
        id: userMessageId,
        channelId,
        role: MessageRole.USER,
        content: input.content,
        userId: ctx.userId,
        previousHash: "",
        hash: userMessageHash,
      });

      const linksRepo = new MessageLinksRepository(db);
      await linksRepo.create({
        messageId: userMessageId,
        targetType: MessageLinkTargetType.ENTITY,
        targetId: input.entityId,
        relationshipType: MessageLinkRelationshipType.COMMENTS,
        userId: ctx.userId,
        workspaceId,
      });

      emitChatEvent({
        event: "channel:created",
        data: { channelId, userId: ctx.userId },
        workspaceId,
        userId: ctx.userId,
      });

      return { channelId, messageId: userMessageId };
    }),

  /**
   * Send message to Intelligence Hub and get AI response (with streaming).
   * When threadId is omitted, the backend creates a new channel and attaches the message.
   */
  sendMessage: protectedProcedure
    .use(aiRateLimitMiddleware)
    .input(
      z.object({
        /** When omitted, backend creates a new channel and returns its id. */
        channelId: z.string().uuid().optional(),
        content: z.string().min(1).max(50_000),
        workspaceId: z.string().uuid().optional(),
        /** UUID of the agent to use — validated against agents table */
        agentId: z.string().uuid().optional(),
        /** @mention handle, e.g. "cto" or "ai" — resolved to agent slug for this call only */
        agentHandle: z.string().optional(),
        /** Originating channel ID when spawning a new THREAD from a non-AI channel */
        parentChannelId: z.string().uuid().optional(),
        /** Entity IDs of uploaded files to attach to this message */
        attachmentEntityIds: z.array(z.string().uuid()).max(10).optional(),
        /** Deep Analysis mode — routes to the COMPLEX tier (Opus) for max reasoning quality */
        deepAnalysis: z.boolean().optional(),
        /** Structural family for resolving default channel when channelId is omitted */
        aiChannelFamily: z.enum(AI_CHANNEL_FAMILY_VALUES).optional(),
        contextObjectId: z.string().uuid().optional(),
        contextObjectType: z.enum(CONTEXT_OBJECT_TYPE_VALUES).optional(),
        branchPurpose: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // protectedProcedure guarantees userId — narrow type for Drizzle compatibility
      const userId = ctx.userId!;
      let channelId = input.channelId;
      const content = input.content;
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
      const requestedAgentId: string | undefined = input.agentId;

      // Resolve @mention handle → agent slug (for per-call override, not stored on channel)
      const resolvedHandle = input.agentHandle
        ? await resolveAgentHandle(input.agentHandle)
        : null;
      const mentionedAgentType =
        resolvedHandle?.agentSlug ?? extractMentionAgentType(content);

      // Resolve agentId: validate if provided, otherwise query for active orchestrator
      let resolvedAgentId: string;
      try {
        resolvedAgentId = await resolveAgentId(requestedAgentId);
      } catch (err) {
        logger.error(
          { err },
          "Failed to resolve agentId, falling back to orchestrator"
        );
        try {
          const [orchestrator] = await db
            .select()
            .from(agents)
            .where(
              and(eq(agents.slug, "orchestrator"), eq(agents.active, true))
            )
            .limit(1);
          resolvedAgentId = orchestrator?.id ?? randomUUID();
        } catch {
          resolvedAgentId = randomUUID();
        }
      }

      // Route to channel when not provided
      if (!channelId) {
        if (!workspaceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "workspaceId is required when sending a message without a thread",
          });
        }

        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId)
          ),
        });
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a member of this workspace",
          });
        }
        const resolvedChannel = await resolveAiChannelByFamily({
          userId,
          workspaceId,
          family: input.aiChannelFamily ?? "agent",
          contextObjectId: input.contextObjectId,
          contextObjectType: input.contextObjectType,
          parentChannelId: input.parentChannelId,
          branchPurpose: input.branchPurpose,
        });
        channelId = resolvedChannel.id;
      }

      // Get channel
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      // Verify the user has access to the channel's workspace
      if (channel.workspaceId && channel.userId !== userId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, channel.workspaceId),
            eq(workspaceMembers.userId, userId)
          ),
        });
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You do not have access to this channel",
          });
        }
      }

      // If no explicit agentId in the request and channel has an assigned agent, use it for IS routing
      if (!requestedAgentId && channel.assignedAgentId) {
        try {
          const channelAgent = await new AgentRepository(db).getById(
            channel.assignedAgentId
          );
          if (channelAgent?.active) {
            resolvedAgentId = channelAgent.id;
          }
        } catch {
          // non-fatal, keep resolvedAgentId from resolveAgentId()
        }
      }

      // Get or create an active session for this channel so messages are session-scoped.
      // This is idempotent — the IS also calls getOrCreate, they'll both resolve to the same session.
      let activeSessionId: string | undefined;
      if (
        channel.channelType === ChannelType.THREAD ||
        channel.channelType === ChannelType.AGENT_COLLAB
      ) {
        try {
          const existingSession = await db.query.sessions.findFirst({
            where: and(
              eq(sessions.channelId, channelId),
              eq(sessions.status, SessionStatus.ACTIVE)
            ),
            columns: { id: true },
          });
          if (existingSession) {
            activeSessionId = existingSession.id;
          } else {
            const newSessionId = randomUUID();
            await db
              .insert(sessions)
              .values({
                id: newSessionId,
                channelId,
                status: SessionStatus.ACTIVE,
              })
              .onConflictDoNothing();
            // Re-query to get the canonical session — handles the race where two concurrent
            // sendMessage calls both find no session and both try to insert.
            const canonical = await db.query.sessions.findFirst({
              where: and(
                eq(sessions.channelId, channelId),
                eq(sessions.status, SessionStatus.ACTIVE)
              ),
              columns: { id: true },
              orderBy: (s, { asc }) => [asc(s.startedAt)],
            });
            activeSessionId = canonical?.id ?? newSessionId;
          }
        } catch {
          // Non-fatal — messages still saved, session tracking degrades gracefully
        }
      }

      // Save user message
      const userMessageId = randomUUID();
      const userMessageHash = createHash("sha256")
        .update(`${userMessageId}${content}`)
        .digest("hex");

      await db.insert(messages).values({
        id: userMessageId,
        channelId,
        role: MessageRole.USER,
        content,
        userId: userId,
        previousHash: "",
        hash: userMessageHash,
        sessionId: activeSessionId ?? undefined,
      });

      // Link attachment entities to channel context
      if (input.attachmentEntityIds?.length) {
        const attachmentMeta: Array<{
          entityId: string;
          fileName: unknown;
          mimeType: unknown;
        }> = [];

        for (const attachEntityId of input.attachmentEntityIds) {
          // Verify entity exists and is a file belonging to this user
          const entity = await db.query.entities.findFirst({
            where: and(
              eq(entitiesTable.id, attachEntityId),
              eq(entitiesTable.type, "file")
            ),
            columns: { id: true, properties: true },
          });
          if (!entity) continue;

          const props = entity.properties as Record<string, unknown>;
          attachmentMeta.push({
            entityId: attachEntityId,
            fileName: props.fileName,
            mimeType: props.mimeType,
          });

          // Link to channel context
          await db
            .insert(channelContextItems)
            .values({
              channelId,
              objectType: "entity",
              objectId: attachEntityId,
              relationshipType: "used_as_context",
              userId: userId,
              workspaceId: channel.workspaceId!,
            })
            .onConflictDoNothing();
        }

        // Update message metadata with attachments
        if (attachmentMeta.length > 0) {
          await db
            .update(messages)
            .set({
              metadata: drizzleSql`COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ attachments: attachmentMeta })}::jsonb`,
            })
            .where(eq(messages.id, userMessageId));
        }
      }

      // Auto-provision agent user for this human+workspace pair (idempotent)
      let agentUserId: string | undefined;
      if (workspaceId) {
        try {
          agentUserId = await ensureAgentUser(userId, workspaceId);
        } catch (err) {
          // Non-critical — degrade gracefully
          logger.error({ err, channelId }, "Failed to ensure agent user");
        }
      }

      // Resolve intelligence service: prefer agentId → intelligenceServiceId lookup,
      // fall back to workspace/user preference routing.
      const resolvedService = await resolveIntelligenceServiceByAgentId(
        resolvedAgentId,
        {
          userId: userId,
          workspaceId: ctx.workspaceId || undefined,
          capability: "chat",
        }
      );

      // TODO(hydration-onboarding, Phase 3): route the first N user messages
      // on a brand-new personal channel through OnboardingAgent instead of
      // the Orchestrator (personal agentType).
      //
      // What is needed before this can land:
      //   1. A cheap "messages on this channel" count or a dedicated
      //      `channel.onboardingState` column ({ status, remainingTurns }) —
      //      counting on every send is O(N) today.
      //   2. A per-call agentType override for this path that feeds the IS
      //      "onboarding" while the channel's stored senderAgentId stays
      //      PERSONAL (so history + memory continue to belong to the
      //      Orchestrator once hydration completes).
      //   3. A graceful hand-off: OnboardingAgent writes its distilled
      //      context into session state so the Orchestrator picks up where
      //      it left off on message N+1.
      //   4. A Studio-aware trigger (surface = "studio" from Task B) so
      //      Relay / Browser keep their current flow unchanged.
      //
      // For now: the first Orchestrator greeting seeded in
      // `ensurePersonalChannel()` does the hydration opener statically;
      // follow-up messages continue through the Orchestrator as today.

      // AI routing gate:
      //   thread/external: AI active when assignedAgentId (or legacy senderAgentId) is set.
      //   agent_collab: always AI-active.
      //   feed: never AI-driven from user message.
      const effectiveAgentRef =
        channel.assignedAgentId ?? channel.senderAgentId;
      const channelKind: "pm" | "group" =
        channel.threadKind === ThreadKind.PERSONAL ||
        (channel.threadKind === ThreadKind.BRANCH && !channel.workspaceId)
          ? "pm"
          : "group";
      const isAiChannel =
        channel.channelType === ChannelType.AGENT_COLLAB ||
        (channel.channelType === ChannelType.THREAD && !!effectiveAgentRef) ||
        (channel.channelType === ChannelType.EXTERNAL && !!effectiveAgentRef);

      // Automation side-effects: channel.message.created.completed for channel_message triggers
      emitSideEffects({
        subjectType: "channel_message",
        action: "created",
        subjectId: userMessageId,
        userId,
        workspaceId: workspaceId ?? channel.workspaceId ?? undefined,
        data: {
          channelId,
          messageRole: MessageRole.USER,
        },
      });

      if (!isAiChannel) {
        return { messageId: userMessageId, channelId };
      }

      // Stream from Intelligence Service
      let fullContent = "";
      const aiSteps: AIStep[] = [];
      // Proposals created by backend governance during this AI response
      const createdProposals: Array<{
        proposalId: string;
        toolName: string;
        description: string;
      }> = [];
      let hubResponse: Partial<HubResponse> = { content: "" };

      // Effective agent type: @mention override → assignedAgentId (or legacy senderAgentId) → default
      let effectiveAgentType = "meta";
      if (mentionedAgentType) {
        effectiveAgentType = mentionedAgentType;
      } else if (effectiveAgentRef) {
        const agentRepo = new AgentRepository(db);
        const agent = await agentRepo.getById(effectiveAgentRef);
        effectiveAgentType = agent?.slug ?? "meta";
      }

      // Fetch workspace MCP server configs (cached 30s — avoids a DB hit on every message).
      // Only approved + enabled servers are forwarded to Intelligence Hub.
      let mcpServersList: McpServerEntry[] | undefined;
      if (workspaceId) {
        try {
          const rows = await getMcpServersForWorkspace(workspaceId);
          if (rows.length > 0) {
            mcpServersList = rows;
          }
        } catch {
          // Non-critical — agents still work without MCP servers
        }
      }
      // Filter to per-channel MCPs if the channel has an explicit opt-in list.
      // null = backward-compat (use workspace defaults); [] = no MCPs; [...] = explicit subset.
      const channelMcpIds = channel.mcpServerIds as string[] | null;
      if (channelMcpIds !== null && channelMcpIds !== undefined) {
        // Per-channel opt-in: only include MCPs explicitly added to this channel
        mcpServersList =
          channelMcpIds.length > 0
            ? mcpServersList?.filter((s) => channelMcpIds.includes(s.id))
            : undefined; // empty array = no MCPs
      }
      // If channelMcpIds is null, use workspace defaults (backward compat)
      // Inject the resolved intelligence service's MCP endpoint (e.g. ZeroClaw/OpenClaw)
      // as a pre-configured HTTP MCP server so agents can use its local tools.
      // Guard: only inject if explicitly approved — prevents unauthorized tool injection.
      if (resolvedService.mcpEndpoint && resolvedService.mcpApproved) {
        const serviceMcpEntry = {
          id: resolvedService.serviceId,
          name: resolvedService.serviceId,
          transport: "http" as const,
          url: resolvedService.mcpEndpoint,
          enabled: true,
        };
        mcpServersList = mcpServersList
          ? [
              ...mcpServersList.filter(
                (s) => s.id !== resolvedService.serviceId
              ),
              serviceMcpEntry,
            ]
          : [serviceMcpEntry];
      }

      // 8-minute hard deadline — if the IS hangs mid-stream, break out and
      // emit a complete event so the frontend is never permanently stuck.
      const streamDeadline = new AbortController();
      const streamDeadlineTimer = setTimeout(
        () => {
          logger.error({ channelId }, "Stream deadline exceeded — aborting");
          streamDeadline.abort();
        },
        8 * 60 * 1000
      );

      // Merge workspace-level agentPersonality into agentConfig so the IS picks it up.
      // Channel agentConfig takes precedence (more specific) over workspace defaults.
      let effectiveAgentConfig = (channel.agentConfig ?? {}) as Record<
        string,
        unknown
      >;
      let workspaceSettingsForIS: Record<string, unknown> | undefined;
      if (workspaceId) {
        try {
          const [wsRow] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1);
          const wsSettings = wsRow?.settings as
            | {
                agentPersonality?: string;
                agentModelPreferences?: Record<string, unknown>;
              }
            | undefined;
          const wsPersonality = wsSettings?.agentPersonality;
          if (wsPersonality && !effectiveAgentConfig.personality) {
            effectiveAgentConfig = {
              ...effectiveAgentConfig,
              personality: wsPersonality,
            };
          }
          // Forward agentModelPreferences so IS can apply tier overrides
          if (wsSettings?.agentModelPreferences) {
            workspaceSettingsForIS = {
              agentModelPreferences: wsSettings.agentModelPreferences,
            };
          }
        } catch {
          // Non-critical — skip personality and model prefs if fetch fails
        }
      }

      try {
        const stream = resolvedService.client.sendMessageStream({
          query: content,
          threadId: channelId,
          userId: userId,
          agentId: resolvedAgentId,
          agentType: effectiveAgentType,
          // Personality overlay: channel config merged with workspace-level agentPersonality
          agentConfig:
            Object.keys(effectiveAgentConfig).length > 0
              ? effectiveAgentConfig
              : undefined,
          workspaceId,
          // Link proposals created during this response to the triggering user message
          sourceMessageId: userMessageId,
          // Per-human AI agent user — enables full attribution for hub-protocol tool calls
          agentUserId: agentUserId ?? resolvedService.agentUserId,
          // MCP servers configured for this workspace
          mcpServers: mcpServersList,
          // Deep Analysis: user opted into COMPLEX tier for this message
          deepAnalysis: input.deepAnalysis,
          // Workspace model preferences — IS reads agentModelPreferences
          workspaceSettings: workspaceSettingsForIS,
          // Entity context: when channel is scoped to an entity, forward for prompt injection
          contextObjectType: channel.contextObjectType ?? undefined,
          contextObjectId: channel.contextObjectId ?? undefined,
          // Pod credentials — IS uses these to call back into this pod via Hub Protocol
          dataPodUrl: process.env.PUBLIC_URL || `https://${process.env.DOMAIN}`,
          dataPodApiKey: process.env.HUB_PROTOCOL_API_KEY || "",
          // Billing channel: Browser chat is included in subscription
          // Channel kind: signals to IS whether this is a private or shared channel
          channelKind,
        });

        for await (const chunk of stream) {
          if (streamDeadline.signal.aborted) break;
          if (chunk.type === "chunk" && chunk.content) {
            fullContent += chunk.content;

            emitChatEvent({
              event: "chat:stream",
              data: {
                threadId: channelId,
                type: "chunk",
                content: chunk.content,
                isComplete: false,
              },
              workspaceId: workspaceId ?? null,
              userId: userId,
              channelId,
            });
          } else if (chunk.type === "step" && chunk.step) {
            aiSteps.push(chunk.step);

            emitChatEvent({
              event: "ai:step",
              data: {
                threadId: channelId,
                messageId: userMessageId,
                step: chunk.step,
              },
              workspaceId: workspaceId ?? null,
              userId: userId,
              channelId,
            });
          } else if (chunk.type === "entities" && chunk.entities) {
            hubResponse.entities = chunk.entities;
          } else if (chunk.type === "branch_decision" && chunk.decision) {
            hubResponse.branchDecision = chunk.decision;

            emitChatEvent({
              event: "branch_decision",
              data: {
                threadId: channelId,
                messageId: userMessageId,
                decision: chunk.decision,
              },
              workspaceId: workspaceId ?? null,
              userId: userId,
              channelId,
            });
          } else if (
            chunk.type === "route_to_channel" &&
            (chunk as any).routing
          ) {
            emitChatEvent({
              event: "route_to_channel",
              data: {
                threadId: channelId,
                messageId: userMessageId,
                routing: (chunk as any).routing,
              },
              workspaceId: workspaceId ?? null,
              userId: userId,
              channelId,
            });
          } else if (chunk.type === "complete") {
            if (chunk.data) {
              const data = chunk.data as Partial<HubResponse>;
              hubResponse = { ...hubResponse, ...data };
              // Collect proposals created by backend governance during this response
              const incoming = (data as Record<string, unknown>)
                .createdProposals as
                | Array<{
                    proposalId: string;
                    toolName: string;
                    description: string;
                  }>
                | undefined;
              if (incoming?.length) {
                createdProposals.push(...incoming);
              }
            }

            // Notify client of each proposal created during this AI response
            for (const cp of createdProposals) {
              emitChatEvent({
                event: "ai:proposal",
                data: {
                  threadId: channelId,
                  messageId: userMessageId,
                  proposalId: cp.proposalId,
                  toolName: cp.toolName,
                  description: cp.description,
                  agentUserId: agentUserId ?? resolvedService.agentUserId,
                },
                workspaceId: workspaceId ?? null,
                userId: userId,
                channelId,
              });
            }

            // Echo agentType to the client so the PersonaChip can slide-in animate
            // the transition when a branch-dispatched specialist answered.
            // Prefers IS-reported agentType, falls back to the type we dispatched with.
            const completedAgentType =
              (chunk.data as { agentType?: string } | undefined)?.agentType ??
              effectiveAgentType;
            emitChatEvent({
              event: "chat:stream",
              data: {
                threadId: channelId,
                type: "complete",
                isComplete: true,
                agentType: completedAgentType,
              },
              workspaceId: workspaceId ?? null,
              userId: userId,
              channelId,
            });
          }
        }
      } catch (streamError) {
        const streamErrMsg =
          streamError instanceof Error
            ? streamError.message
            : String(streamError);
        const isStreamAuthError =
          streamErrMsg.includes("401") || streamErrMsg.includes("Unauthorized");
        logger.error(
          {
            err: streamError,
            channelId,
            serviceId: resolvedService.serviceId,
            endpoint: resolvedService.endpoint,
            isCircuit: streamErrMsg.includes("circuit open"),
            isAbort: streamErrMsg.includes("abort"),
            isAuthError: isStreamAuthError,
          },
          "Streaming error, falling back to non-streaming"
        );

        // Trigger auto-repair on auth errors so the next request succeeds
        if (isStreamAuthError) {
          try {
            const { markServiceCredentialError } =
              await import("../utils/credential-auto-repair.js");
            markServiceCredentialError();
          } catch {
            /* best-effort */
          }
        }

        emitChatEvent({
          event: "chat:stream:error",
          data: {
            threadId: channelId,
            error:
              streamError instanceof Error
                ? streamError.message
                : "Streaming failed",
            fallback: true,
          },
          workspaceId: workspaceId ?? null,
          userId: userId,
          channelId,
        });

        try {
          hubResponse = await resolvedService.client.sendMessage({
            query: content,
            threadId: channelId,
            userId: userId,
            agentId: resolvedAgentId,
            agentType: effectiveAgentType,
            workspaceId,
            sourceMessageId: userMessageId,
            agentUserId: agentUserId ?? resolvedService.agentUserId,
            mcpServers: mcpServersList,
            dataPodUrl:
              process.env.PUBLIC_URL || `https://${process.env.DOMAIN}`,
            dataPodApiKey: process.env.HUB_PROTOCOL_API_KEY || "",
            channelKind,
          });
        } catch (fallbackError) {
          // Both stream and non-streaming fallback failed — Intelligence Hub is down
          const errorDetail =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          const isCircuit = errorDetail.includes("circuit open");
          const isTimeout =
            errorDetail.includes("abort") || errorDetail.includes("timeout");

          logger.error(
            { err: fallbackError, channelId, isCircuit, isTimeout },
            "Both streaming and non-streaming IS calls failed"
          );

          // User-facing message with actionable context
          const isAuthError =
            errorDetail.includes("401") ||
            errorDetail.includes("Unauthorized") ||
            errorDetail.includes("credential");
          if (isAuthError) {
            // Auto-repair: request fresh credentials from CP in the background.
            // The current request fails gracefully, but the next one should succeed.
            try {
              const { markServiceCredentialError } =
                await import("../utils/credential-auto-repair.js");
              markServiceCredentialError();
            } catch {
              // Non-critical — auto-repair is best-effort
            }
            fullContent =
              "The AI service credentials are being refreshed automatically. Please try again in a moment.";
          } else if (isCircuit) {
            fullContent =
              "The AI service is recovering from a temporary overload. Please wait 30 seconds and try again.";
          } else if (isTimeout) {
            fullContent =
              "The AI service took too long to respond. This usually resolves on its own — please try again.";
          } else {
            fullContent =
              "The AI service is temporarily unavailable. Please try again in a moment.";
          }

          emitChatEvent({
            event: "chat:stream:error",
            data: {
              threadId: channelId,
              error: errorDetail,
              fallback: false,
            },
            workspaceId: workspaceId ?? null,
            userId: userId,
            channelId,
          });
        }

        fullContent = hubResponse?.content || fullContent || "";

        // Recover any proposals created during the (failed) stream or fallback response
        const fallbackProposals = hubResponse.createdProposals ?? [];
        if (fallbackProposals.length > 0) {
          createdProposals.push(...fallbackProposals);
          for (const cp of fallbackProposals) {
            emitChatEvent({
              event: "ai:proposal",
              data: {
                threadId: channelId,
                messageId: userMessageId,
                proposalId: cp.proposalId,
                toolName: cp.toolName,
                description: cp.description,
                agentUserId: agentUserId ?? resolvedService.agentUserId,
              },
              workspaceId: workspaceId ?? null,
              userId: userId,
              channelId,
            });
          }
        }
      } finally {
        clearTimeout(streamDeadlineTimer);
        // If the 8-minute deadline fired and we got no content (IS permanently hung),
        // emit a completion event so the frontend is never left waiting forever.
        if (streamDeadline.signal.aborted && !fullContent) {
          emitChatEvent({
            event: "chat:stream",
            data: {
              threadId: channelId,
              type: "complete",
              isComplete: true,
              timedOut: true,
              agentType: effectiveAgentType,
            },
            workspaceId: workspaceId ?? null,
            userId: userId,
            channelId,
          });
          fullContent = "The AI response timed out. Please try again.";
        }
      }

      // Save assistant message
      const assistantMessageId = randomUUID();
      const assistantMessageHash = createHash("sha256")
        .update(`${assistantMessageId}${fullContent}${userMessageHash}`)
        .digest("hex");
      const messageMetadata = { aiSteps };

      await db.insert(messages).values({
        id: assistantMessageId,
        channelId,
        role: MessageRole.ASSISTANT,
        authorType: MessageAuthorType.AI_AGENT,
        content: fullContent,
        userId,
        previousHash: userMessageHash,
        hash: assistantMessageHash,
        metadata: messageMetadata as (typeof messages.$inferInsert)["metadata"],
        sessionId: activeSessionId ?? undefined,
      });

      // Automation side-effects: channel.message.created.completed for assistant reply
      emitSideEffects({
        subjectType: "channel_message",
        action: "created",
        subjectId: assistantMessageId,
        userId,
        workspaceId: workspaceId ?? channel.workspaceId ?? undefined,
        data: {
          channelId,
          messageRole: MessageRole.ASSISTANT,
        },
      });

      // Update session activity + token usage (fire-and-forget — non-critical)
      if (activeSessionId) {
        const totalTokens = hubResponse?.usage?.totalTokens;
        db.update(sessions)
          .set({
            lastActivityAt: new Date(),
            ...(totalTokens
              ? {
                  totalTokensUsed: drizzleSql`COALESCE(total_tokens_used, 0) + ${totalTokens}`,
                  messageCount: drizzleSql`COALESCE(message_count, 0) + 2`,
                }
              : { messageCount: drizzleSql`COALESCE(message_count, 0) + 2` }),
          })
          .where(eq(sessions.id, activeSessionId))
          .catch((err) => {
            logger.warn(
              { err, sessionId: activeSessionId },
              "Session activity/token update failed"
            );
          });
      }

      // Create entities via event chain
      const createdEntities = [];
      const entities = hubResponse?.entities || [];

      if (entities.length > 0) {
        try {
          for (const entity of entities) {
            await getBoss().send("entity-embedding", {
              type: entity.type,
              title: entity.title,
              preview: entity.description,
              userId: userId,
              workspaceId: workspaceId ?? ctx.workspaceId,
              source: "chat-extraction",
              action: "create",
            });

            createdEntities.push({
              type: entity.type,
              title: entity.title,
              status: "requested",
            });
          }
        } catch (err) {
          // Non-critical — entity embedding is a background enrichment.
          // Job queue being down should not fail the chat message.
          console.warn("[sendMessage] Entity embedding job queue failed:", err);
        }
      }

      emitChatEvent({
        event: "chat:message",
        data: {
          threadId: channelId,
          message: {
            id: assistantMessageId,
            threadId: channelId,
            role: MessageRole.ASSISTANT,
            content: fullContent,
            userId: userId,
            timestamp: new Date(),
            previousHash: userMessageHash,
            hash: assistantMessageHash,
            metadata: messageMetadata,
          },
          userId: userId,
        },
        workspaceId: workspaceId ?? null,
        userId: userId,
      });

      // Outbound relay: for EXTERNAL channels, forward the AI response back to
      // the external platform via OpenClaw's OpenAI-compatible endpoint.
      // Non-blocking — failure here must never affect the response to the frontend.
      const externalMeta = (channel.metadata ?? {}) as {
        relayEnabled?: boolean;
        connectorLive?: boolean;
      };
      const relayToExternalEnabled =
        externalMeta.relayEnabled === true &&
        externalMeta.connectorLive === true;
      if (
        channel.channelType === ChannelType.EXTERNAL &&
        relayToExternalEnabled &&
        channel.externalSource &&
        channel.externalChannelId &&
        fullContent
      ) {
        relayToExternalChannel({
          workspaceId: workspaceId || channel.workspaceId || undefined,
          userId: userId,
          externalSource: channel.externalSource,
          externalChannelId: channel.externalChannelId,
          content: fullContent,
        }).catch((err) => {
          logger.error(
            { err, channelId, externalSource: channel.externalSource },
            "Outbound relay to external channel failed"
          );
        });
      }

      // Create branch if decided
      let branchChannel = undefined;
      const branchDecision = hubResponse?.branchDecision;
      if (branchDecision?.shouldBranch) {
        const [branch] = await db
          .insert(channels)
          .values({
            userId: userId,
            parentChannelId: channelId,
            branchedFromMessageId: assistantMessageId,
            branchPurpose:
              branchDecision.suggestedPurpose || branchDecision.reason,
            channelType: ChannelType.THREAD,
            threadKind: ThreadKind.BRANCH,
            status: ChannelStatus.ACTIVE,
          })
          .returning();

        branchChannel = branch;
      }

      // Auto-title: generate a short title from the first user message when channel has no title.
      // Fires fire-and-forget so it never blocks the response.
      if (
        !channel.title &&
        channel.channelType === ChannelType.THREAD &&
        content
      ) {
        (async () => {
          try {
            // Derive a concise title (≤ 60 chars) from the user message content.
            // Strips markdown syntax, trims to word boundary, capitalises first letter.
            const raw = content
              .replace(/[#*_`~[\]()>!]/g, " ") // strip markdown punctuation
              .replace(/\s+/g, " ")
              .trim();
            const truncated =
              raw.length <= 60
                ? raw
                : raw
                    .slice(0, 60)
                    .replace(/\s\S*$/, "")
                    .trim();
            const autoTitle =
              truncated.charAt(0).toUpperCase() + truncated.slice(1);
            if (!autoTitle) return;

            await db
              .update(channels)
              .set({ title: autoTitle, updatedAt: new Date() })
              .where(eq(channels.id, channelId));

            emitChatEvent({
              event: "channel:updated",
              data: { channelId, userId: userId },
              workspaceId: workspaceId ?? null,
              userId: userId,
            });
          } catch {
            // Non-critical — title generation is best-effort
          }
        })();
      }

      await db
        .update(channels)
        .set({ updatedAt: new Date() })
        .where(eq(channels.id, channelId));

      return {
        channelId,
        messageId: assistantMessageId,
        content: fullContent,
        entities: createdEntities,
        branchDecision,
        branchThread: branchChannel,
        aiSteps,
      };
    }),

  /**
   * Get messages for a channel (with cursor pagination)
   */
  getMessages: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        cursor: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.threadId),
      });
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }
      if (channel.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied to this channel",
        });
      }
      // Personal-style threads and feed channels are pod-wide.
      const isPodWideChannel =
        channel.channelType === ChannelType.FEED ||
        (channel.channelType === ChannelType.THREAD &&
          channel.threadKind === ThreadKind.PERSONAL);
      if (
        !isPodWideChannel &&
        ctx.workspaceId &&
        channel.workspaceId &&
        channel.workspaceId !== ctx.workspaceId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Channel is not in the current workspace",
        });
      }

      const msgs = await db.query.messages.findMany({
        where: and(
          eq(messages.channelId, input.threadId),
          isNull(messages.deletedAt),
          input.cursor ? lt(messages.id, input.cursor) : undefined
        ),
        orderBy: [desc(messages.timestamp)],
        limit: input.limit + 1,
      });

      const hasMore = msgs.length > input.limit;
      const nextCursor = hasMore ? msgs[input.limit - 1].id : undefined;

      return {
        messages: hasMore ? msgs.slice(0, -1) : msgs,
        nextCursor,
        hasMore,
      };
    }),

  /**
   * List channels (optionally filtered by workspace)
   */
  listChannels: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        channelType: z.enum(CHANNEL_TYPE_VALUES).optional(),
        threadKind: z.enum(THREAD_KIND_VALUES).optional(),
        limit: z.number().min(1).max(100).default(20),
        contextObjectId: z.string().uuid().optional(),
        contextObjectType: z.enum(CONTEXT_OBJECT_TYPE_VALUES).optional(),
        assignedAgentId: z.string().uuid().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const channelsWithFlags = await listChannelsWithFlags({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        channelType: input.channelType,
        threadKind: input.threadKind,
        contextObjectId: input.contextObjectId,
        contextObjectType: input.contextObjectType,
        assignedAgentId: input.assignedAgentId,
        limit: input.limit,
      });

      if (channelsWithFlags.length === 0) {
        return { channels: [] };
      }

      return { channels: channelsWithFlags };
    }),

  /**
   * List only thread channels.
   */
  listThreads: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        threadKind: z.enum(THREAD_KIND_VALUES).optional(),
        contextObjectId: z.string().uuid().optional(),
        contextObjectType: z.enum(CONTEXT_OBJECT_TYPE_VALUES).optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const items = await listChannelsWithFlags({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        channelType: ChannelType.THREAD,
        threadKind: input.threadKind,
        contextObjectId: input.contextObjectId,
        contextObjectType: input.contextObjectType,
        limit: input.limit + 1,
        offset: input.offset,
      });

      const hasMore = items.length > input.limit;
      const trimmed = hasMore ? items.slice(0, input.limit) : items;
      return {
        items: trimmed,
        pagination: {
          hasMore,
          limit: input.limit,
          offset: input.offset,
        },
      };
    }),

  /**
   * List only feed channels.
   */
  listFeeds: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        feedScope: z.enum([FeedScope.USER, FeedScope.WORKSPACE]).optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const items = await listChannelsWithFlags({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        channelType: ChannelType.FEED,
        feedScope: input.feedScope,
        limit: input.limit + 1,
        offset: input.offset,
      });

      const hasMore = items.length > input.limit;
      const trimmed = hasMore ? items.slice(0, input.limit) : items;
      return {
        items: trimmed,
        pagination: {
          hasMore,
          limit: input.limit,
          offset: input.offset,
        },
      };
    }),

  /**
   * List only external channels.
   */
  listExternalChannels: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const items = await listChannelsWithFlags({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        channelType: ChannelType.EXTERNAL,
        limit: input.limit + 1,
        offset: input.offset,
      });

      const hasMore = items.length > input.limit;
      const trimmed = hasMore ? items.slice(0, input.limit) : items;
      return {
        items: trimmed,
        pagination: {
          hasMore,
          limit: input.limit,
          offset: input.offset,
        },
      };
    }),

  /**
   * List only agent collaboration channels.
   */
  listAgentCollabChannels: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const items = await listChannelsWithFlags({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        channelType: ChannelType.AGENT_COLLAB,
        limit: input.limit + 1,
        offset: input.offset,
      });

      const hasMore = items.length > input.limit;
      const trimmed = hasMore ? items.slice(0, input.limit) : items;
      return {
        items: trimmed,
        pagination: {
          hasMore,
          limit: input.limit,
          offset: input.offset,
        },
      };
    }),

  /**
   * Get or create a private thread between the current user and a specific agent.
   * Pod-scoped: one per (userId, agentId). Returns channel immediately (fast, no IS call).
   */
  getOrCreateAgentThread: workspaceProcedure
    .input(z.object({ agentId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const channel = await resolveAiChannelByFamily({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        family: "agent",
        agentId: input.agentId,
      });
      return { channel };
    }),

  /**
   * Get or create the workspace-wide group thread.
   * One per (userId, workspaceId). Agents can be @mentioned; no assigned agent by default.
   */
  getOrCreateWorkspaceGroup: workspaceProcedure
    .input(z.object({}))
    .query(async ({ ctx }) => {
      const channel = await resolveAiChannelByFamily({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        family: "workspace_group",
      });
      return { channel };
    }),

  /**
   * Get branch channels for a parent channel
   */
  getBranches: protectedProcedure
    .input(
      z.object({
        parentChannelId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const branches = await db.query.channels.findMany({
        where: eq(channels.parentChannelId, input.parentChannelId),
        orderBy: [desc(channels.createdAt)],
      });

      return { branches };
    }),

  /**
   * Get all branch trees for a workspace — returns all root channels with their
   * children recursively, plus pending proposal counts per channel.
   */
  getWorkspaceBranchTree: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const allChannels = await db.query.channels.findMany({
        where: and(
          eq(channels.userId, ctx.userId),
          eq(channels.workspaceId, input.workspaceId)
        ),
        orderBy: [desc(channels.updatedAt)],
      });

      if (allChannels.length === 0) {
        return {
          roots: [],
          stats: {
            totalChannels: 0,
            activeChannels: 0,
            pendingProposalsTotal: 0,
          },
          proposalCounts: {},
        };
      }

      const channelIds = allChannels.map((c) => c.id);

      // Count messages per channel
      const messageCounts = await db
        .select({ channelId: messages.channelId })
        .from(messages)
        .where(inArray(messages.channelId, channelIds));
      const messageCountMap: Record<string, number> = {};
      for (const row of messageCounts) {
        if (row.channelId) {
          messageCountMap[row.channelId] =
            (messageCountMap[row.channelId] || 0) + 1;
        }
      }

      // Count pending proposals per channel
      const pendingProposalRows = await db
        .select({
          threadId: proposals.threadId,
          count: drizzleSql<number>`count(*)::int`,
        })
        .from(proposals)
        .where(
          and(
            eq(proposals.workspaceId, input.workspaceId),
            eq(proposals.status, ProposalStatus.PENDING),
            inArray(proposals.threadId, channelIds)
          )
        )
        .groupBy(proposals.threadId);
      const proposalCounts: Record<string, number> = {};
      let pendingProposalsTotal = 0;
      for (const row of pendingProposalRows) {
        if (row.threadId) {
          proposalCounts[row.threadId] = row.count;
          pendingProposalsTotal += row.count;
        }
      }

      // Build channel map for O(1) child lookup
      const channelMap = new Map(allChannels.map((c) => [c.id, c]));

      function buildNode(channel: Channel, depth: number): BranchNodeResult {
        const children = allChannels
          .filter((c) => c.parentChannelId === channel.id)
          .map((child) => buildNode(child, depth + 1));
        return {
          channel,
          children,
          messageCount: messageCountMap[channel.id] || 0,
          lastActivity: channel.updatedAt,
          depth,
        };
      }

      // Root = no parentChannelId, or parent belongs to a different workspace
      const roots = allChannels
        .filter((c) => !c.parentChannelId || !channelMap.has(c.parentChannelId))
        .map((c) => buildNode(c, 0));

      const activeChannels = allChannels.filter(
        (c) => c.status === "active"
      ).length;

      return {
        roots,
        stats: {
          totalChannels: allChannels.length,
          activeChannels: activeChannels,
          pendingProposalsTotal,
        },
        proposalCounts,
      };
    }),

  /**
   * Merge branch channel into its parent
   */
  mergeBranch: protectedProcedure
    .input(
      z.object({
        branchId: z.string().uuid(),
        summary: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const branch = await db.query.channels.findFirst({
        where: eq(channels.id, input.branchId),
      });

      if (
        !branch ||
        branch.channelType !== ChannelType.THREAD ||
        branch.threadKind !== ThreadKind.BRANCH
      ) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Branch not found" });
      }

      if (!branch.parentChannelId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Branch has no parent channel",
        });
      }

      await db
        .update(channels)
        .set({
          status: ChannelStatus.MERGED,
          mergedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.branchId));

      emitChatEvent({
        event: "channel:merged",
        data: {
          channelId: input.branchId,
          parentChannelId: branch.parentChannelId,
          userId: ctx.userId,
        },
        workspaceId: branch.workspaceId ?? ctx.workspaceId ?? null,
        userId: ctx.userId,
      });

      return {
        status: "merged",
        message: "Branch merged",
      };
    }),

  /**
   * Get single channel with optional context and branches
   */
  getChannel: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        includeContext: z.boolean().default(true),
        includeBranches: z.boolean().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId)
        ),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }
      const isPodWideChannel =
        channel.channelType === ChannelType.FEED ||
        (channel.channelType === ChannelType.THREAD &&
          channel.threadKind === ThreadKind.PERSONAL);
      if (
        !isPodWideChannel &&
        ctx.workspaceId &&
        channel.workspaceId &&
        channel.workspaceId !== ctx.workspaceId
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Channel is not in the current workspace",
        });
      }

      // Get context items (entities + documents) if requested
      let contextItems: (typeof channelContextItems.$inferSelect)[] = [];

      if (input.includeContext) {
        contextItems = await db.query.channelContextItems.findMany({
          where: eq(channelContextItems.channelId, input.channelId),
        });
      }

      // Get branch tree if requested
      let branchTree: any = null;
      if (input.includeBranches) {
        const allBranches = await db.query.channels.findMany({
          where: or(
            eq(channels.id, input.channelId),
            eq(channels.parentChannelId, input.channelId)
          ),
        });

        branchTree = buildBranchTree(allBranches, input.channelId);
      }

      return {
        channel,
        contextItems: input.includeContext ? contextItems : undefined,
        branchTree: input.includeBranches ? branchTree : undefined,
      };
    }),

  /**
   * Update channel metadata
   */
  updateChannel: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        title: z.string().optional(),
        assignedAgentId: z.string().uuid().nullable().optional(),
        agentConfig: z.record(z.string(), z.unknown()).optional(),
        mcpServerIds: z.array(z.string().uuid()).nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId)
        ),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      await db
        .update(channels)
        .set({
          title: input.title,
          assignedAgentId: input.assignedAgentId,
          agentConfig: input.agentConfig,
          ...(input.mcpServerIds !== undefined && {
            mcpServerIds: input.mcpServerIds,
          }),
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.channelId));

      emitChatEvent({
        event: "channel:updated",
        data: { channelId: input.channelId, userId: ctx.userId },
        workspaceId: channel.workspaceId ?? ctx.workspaceId ?? null,
        userId: ctx.userId,
      });

      return {
        status: "updated",
        channelId: input.channelId,
      };
    }),

  /**
   * Add an MCP server to a channel's explicit opt-in list.
   * The server must be approved + enabled in the channel's workspace.
   */
  addMcpToChannel: protectedProcedure
    .input(
      z.object({ channelId: z.string().uuid(), mcpServerId: z.string().uuid() })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId)
        ),
      });
      if (!channel)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });

      // Verify the MCP server exists and is approved in the workspace
      if (channel.workspaceId) {
        const server = await db.query.mcpServers.findFirst({
          where: and(
            eq(mcpServers.id, input.mcpServerId),
            eq(mcpServers.workspaceId, channel.workspaceId),
            eq(mcpServers.approved, true),
            eq(mcpServers.enabled, true)
          ),
        });
        if (!server)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "MCP server not found or not approved",
          });
      }

      const currentIds = (channel.mcpServerIds as string[] | null) ?? [];
      if (currentIds.includes(input.mcpServerId))
        return { channelId: input.channelId };

      await db
        .update(channels)
        .set({
          mcpServerIds: [...currentIds, input.mcpServerId],
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.channelId));

      return { channelId: input.channelId };
    }),

  /**
   * Remove an MCP server from a channel's explicit opt-in list.
   */
  removeMcpFromChannel: protectedProcedure
    .input(
      z.object({ channelId: z.string().uuid(), mcpServerId: z.string().uuid() })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId)
        ),
      });
      if (!channel)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });

      const currentIds = (channel.mcpServerIds as string[] | null) ?? [];
      await db
        .update(channels)
        .set({
          mcpServerIds: currentIds.filter((id) => id !== input.mcpServerId),
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.channelId));

      return { channelId: input.channelId };
    }),

  /**
   * Delete a branch that has no messages (sent when user navigates away without chatting).
   * Safe to call even if the branch has messages — it's a no-op in that case.
   * Only deletes branch-type channels owned by the caller.
   */
  pruneEmptyBranch: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId),
          eq(channels.channelType, ChannelType.THREAD),
          eq(channels.threadKind, ThreadKind.BRANCH)
        ),
      });
      if (!channel) return { pruned: false };

      // Count non-deleted user/assistant messages
      const msgs = await db.query.messages.findMany({
        where: and(
          eq(messages.channelId, input.channelId),
          isNull(messages.deletedAt)
        ),
        columns: { id: true },
        limit: 1,
      });
      if (msgs.length > 0) return { pruned: false };

      // Hard-delete the empty branch
      await db.delete(channels).where(eq(channels.id, input.channelId));
      return { pruned: true };
    }),

  /**
   * Archive channel (soft delete)
   */
  archiveChannel: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId)
        ),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      await db
        .update(channels)
        .set({
          status: ChannelStatus.ARCHIVED,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.channelId));

      emitChatEvent({
        event: "channel:archived",
        data: { channelId: input.channelId, userId: ctx.userId },
        workspaceId: channel.workspaceId ?? ctx.workspaceId ?? null,
        userId: ctx.userId,
      });

      return {
        status: "archived",
        channelId: input.channelId,
      };
    }),

  /**
   * Get branch tree structure (not flat list)
   */
  getBranchTree: protectedProcedure
    .input(
      z.object({
        rootChannelId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const allChannels = await db.query.channels.findMany({
        where: and(
          or(
            eq(channels.id, input.rootChannelId),
            eq(channels.parentChannelId, input.rootChannelId)
          ),
          eq(channels.userId, ctx.userId)
        ),
      });

      const tree = buildBranchTree(allChannels, input.rootChannelId);

      const activeBranches = allChannels.filter(
        (c) =>
          c.status === "active" &&
          c.channelType === ChannelType.THREAD &&
          c.threadKind === ThreadKind.BRANCH
      );
      const mergedBranches = allChannels.filter(
        (c) =>
          c.status === "merged" &&
          c.channelType === ChannelType.THREAD &&
          c.threadKind === ThreadKind.BRANCH
      );

      return {
        tree,
        flatBranches: allChannels.filter(
          (c) =>
            c.channelType === ChannelType.THREAD &&
            c.threadKind === ThreadKind.BRANCH
        ),
        activeBranches,
        mergedBranches,
      };
    }),

  /**
   * Get channel context items (replaces getThreadContext — supports unified entity+document+view queries)
   */
  getChannelContext: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        objectTypes: z
          .array(
            z.enum(["entity", "document", "view", "proposal", "inbox_item"])
          )
          .optional(),
        relationshipTypes: z
          .array(
            z.enum([
              "used_as_context",
              "created",
              "updated",
              "referenced",
              "inherited_from_parent",
            ])
          )
          .optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.userId, ctx.userId)
        ),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      const conditions: any[] = [
        eq(channelContextItems.channelId, input.channelId),
      ];

      if (input.objectTypes?.length) {
        conditions.push(
          inArray(
            channelContextItems.objectType,
            input.objectTypes as ChannelContextObjectType[]
          )
        );
      }

      if (input.relationshipTypes?.length) {
        conditions.push(
          inArray(
            channelContextItems.relationshipType,
            input.relationshipTypes as ChannelContextRelationshipType[]
          )
        );
      }

      const items = await db.query.channelContextItems.findMany({
        where: and(...conditions),
      });

      // For backward compat: split into entities and documents
      const entities = items.filter((i) => i.objectType === "entity");
      const documents = items.filter((i) => i.objectType === "document");

      return {
        items,
        entities,
        documents,
      };
    }),

  /**
   * Explicitly attach a context item to a channel (user-driven, not AI-driven).
   * Idempotent — repeated calls for the same (channelId, objectId, objectType) are no-ops.
   */
  addContextItem: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        objectType: z.enum(["entity", "document", "view"]),
        objectId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.channelId),
      });

      if (!channel?.workspaceId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      await db
        .insert(channelContextItems)
        .values({
          channelId: input.channelId,
          objectType: input.objectType as ChannelContextObjectType,
          objectId: input.objectId,
          relationshipType: ChannelContextRelationshipType.USED_AS_CONTEXT,
          userId: ctx.userId,
          workspaceId: channel.workspaceId,
        })
        .onConflictDoNothing();

      return { ok: true };
    }),

  /**
   * Soft-delete all messages in a channel at or after a given message (by timestamp).
   * Used for regenerate (delete AI response + anything after) and edit (delete from
   * the edited user message onwards so the thread can be re-submitted).
   */
  deleteMessagesFrom: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        fromMessageId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.channelId),
      });
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }
      if (channel.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      // Find the anchor message to get its timestamp
      const anchor = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, input.fromMessageId),
          eq(messages.channelId, input.channelId)
        ),
      });
      if (!anchor) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message not found",
        });
      }

      // Soft-delete all messages at or after the anchor timestamp
      await db
        .update(messages)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(messages.channelId, input.channelId),
            gte(messages.timestamp, anchor.timestamp),
            isNull(messages.deletedAt)
          )
        );

      return { ok: true };
    }),

  /**
   * Remove a user-attached context item from a channel.
   */
  removeContextItem: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        objectId: z.string().uuid(),
        objectType: z.enum(["entity", "document", "view"]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await db
        .delete(channelContextItems)
        .where(
          and(
            eq(channelContextItems.channelId, input.channelId),
            eq(channelContextItems.objectId, input.objectId),
            eq(
              channelContextItems.objectType,
              input.objectType as ChannelContextObjectType
            ),
            eq(channelContextItems.userId, ctx.userId)
          )
        );
      return { ok: true };
    }),

  /**
   * Create (or return existing) external import channel.
   * Used by the import orchestrator and proposal executor for external source channels.
   */
  createExternalChannel: workspaceProcedure
    .input(
      z.object({
        externalSource: z.string().max(100),
        externalChannelId: z.string().max(500),
        title: z.string().max(500),
        externalParticipants: z.array(z.string()).optional(),
        initialMessage: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Return existing channel if already imported
      const [existing] = await db
        .select({ id: channels.id })
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, ctx.workspaceId),
            eq(channels.channelType, ChannelType.EXTERNAL),
            eq(channels.externalChannelId, input.externalChannelId)
          )
        )
        .limit(1);

      if (existing) {
        return { channelId: existing.id, status: "existing" as const };
      }

      const [channel] = await db
        .insert(channels)
        .values({
          id: randomUUID(),
          userId: ctx.userId,
          workspaceId: ctx.workspaceId,
          channelType: ChannelType.EXTERNAL,
          threadKind: ThreadKind.WORKSPACE,
          title: input.title,
          externalSource: input.externalSource,
          externalChannelId: input.externalChannelId,
          metadata: {
            externalParticipants: input.externalParticipants ?? [],
            ...(input.metadata ?? {}),
          },
          status: ChannelStatus.ACTIVE,
        })
        .returning();

      if (input.initialMessage) {
        await db.insert(messages).values({
          id: randomUUID(),
          channelId: channel.id,
          content: input.initialMessage,
          role: MessageRole.USER,
          userId: ctx.userId,
          previousHash: "",
          hash: createHash("sha256").update(input.initialMessage).digest("hex"),
        });
      }

      return { channelId: channel.id, status: "created" as const };
    }),

  /**
   * Patch message metadata — used for feed actions like dismiss/capture.
   */
  patchMessageMetadata: protectedProcedure
    .input(
      z.object({
        messageId: z.string().uuid(),
        channelId: z.string().uuid(),
        metadata: z.record(z.string(), z.unknown()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.channelId),
      });
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }
      if (channel.userId !== ctx.userId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
      }

      const msg = await db.query.messages.findFirst({
        where: and(
          eq(messages.id, input.messageId),
          eq(messages.channelId, input.channelId)
        ),
      });
      if (!msg) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message not found",
        });
      }

      const existing = (msg.metadata ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = {};
      for (const k of Object.keys(existing)) {
        merged[k] = existing[k];
      }
      for (const [k, v] of Object.entries(input.metadata)) {
        merged[k] = v;
      }

      await db
        .update(messages)
        .set({ metadata: merged as any })
        .where(eq(messages.id, input.messageId));

      return { ok: true };
    }),

  /**
   * Upsert a personal feed channel for the caller and attach source
   * subscriptions to it. Called by Relay onboarding (and feed settings) to
   * materialise a user's feed preferences into real backend resources.
   *
   * Idempotent: returns the existing feed channel if one already exists.
   * Each source is matched by URL — duplicate URLs are skipped.
   */
  /**
   * Set up (or update) the user's personal feed channel for a given archetype.
   * Resolves the pre-provisioned source_config for the archetype (seeded by CP
   * at pod provisioning time) and creates a subscription linking it to the
   * user's feed channel.
   *
   * Idempotent: calling again for the same archetype returns the existing
   * channelId without creating duplicates.
   */
  setupFeed: protectedProcedure
    .input(
      z.object({
        archetype: z.enum([
          "leads",
          "hiring",
          "investors",
          "trends",
          "competitors",
          "press",
        ]),
        /** NL context forwarded to IS for relevance scoring */
        criteria: z.string().max(1000).optional(),
        /** Cron schedule — defaults to every 15 minutes */
        scheduleCron: z.string().optional(),
        /** Relevance threshold 0-100 */
        relevanceThreshold: z.number().min(0).max(100).optional(),
        /** Channel display name — defaults to archetype label */
        name: z.string().min(1).max(255).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId;

      // 1. Resolve the archetype source_config seeded by CP provisioning
      const archetypeConfig = await db.query.sourceConfigs.findFirst({
        where: and(
          eq(sourceConfigs.userId, userId),
          drizzleSql`metadata->>'archetype' = ${input.archetype}`,
          drizzleSql`metadata->>'isArchetypeSeed' = 'true'`
        ),
      });

      if (!archetypeConfig) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Feed sources for archetype "${input.archetype}" are not provisioned on this pod yet. Re-provision or contact support.`,
        });
      }

      // 2. Upsert the user's personal feed channel
      let feedChannel = await db.query.channels.findFirst({
        where: and(
          eq(channels.userId, userId),
          eq(channels.channelType, ChannelType.FEED),
          eq(channels.feedScope, FeedScope.USER)
        ),
      });

      if (!feedChannel) {
        const archetypeLabels: Record<string, string> = {
          leads: "Leads",
          hiring: "Hiring",
          investors: "Investors",
          trends: "Trends",
          competitors: "Competitors",
          press: "Press",
        };
        const [created] = await db
          .insert(channels)
          .values({
            id: randomUUID(),
            userId,
            workspaceId: null,
            channelType: ChannelType.FEED,
            feedScope: FeedScope.USER,
            title: input.name ?? archetypeLabels[input.archetype] ?? "My Feed",
            status: ChannelStatus.ACTIVE,
          })
          .returning();
        feedChannel = created;
        logger.info(
          { channelId: feedChannel.id, userId },
          "Feed channel created"
        );
      }

      const channelId = feedChannel.id;

      // 3. Expand archetype + criteria into concrete fetch targets via the CP query planner.
      //    Best-effort: derivedQueries is [] if the CP isn't configured or plan-queries fails.
      const derivedQueries = await deriveFeedQueries(
        archetypeConfig,
        input.archetype,
        input.criteria
      );

      // 4. Upsert subscription — idempotent by (sourceConfigId, feedId)
      const existingSub = await db.query.sourceSubscriptions.findFirst({
        where: and(
          eq(sourceSubscriptions.sourceConfigId, archetypeConfig.id),
          drizzleSql`${sourceSubscriptions.feedId} = ${channelId}`
        ),
      });

      let subscriptionId: string | null = existingSub?.id ?? null;

      if (!existingSub) {
        const [newSub] = await db
          .insert(sourceSubscriptions)
          .values({
            id: randomUUID(),
            userId,
            workspaceId: null,
            sourceConfigId: archetypeConfig.id,
            feedId: channelId,
            status: "active",
            params: {
              feedType: input.archetype,
              scheduleCron: input.scheduleCron ?? "*/15 * * * *",
              agentConfig: {
                feedType: input.archetype,
                criteria: input.criteria ?? "",
                minRelevanceScore: input.relevanceThreshold
                  ? input.relevanceThreshold / 100
                  : 0,
              },
              ...(derivedQueries.length > 0 && { derivedQueries }),
            },
          })
          .returning();
        subscriptionId = newSub.id;
      } else if (
        input.criteria ||
        input.scheduleCron ||
        input.relevanceThreshold !== undefined
      ) {
        // Update criteria/schedule and refresh derived queries on existing subscription
        await db
          .update(sourceSubscriptions)
          .set({
            params: {
              feedType: input.archetype,
              scheduleCron: input.scheduleCron ?? "*/15 * * * *",
              agentConfig: {
                feedType: input.archetype,
                criteria: input.criteria ?? "",
                minRelevanceScore: input.relevanceThreshold
                  ? input.relevanceThreshold / 100
                  : 0,
              },
              ...(derivedQueries.length > 0 && { derivedQueries }),
            },
            updatedAt: new Date(),
          })
          .where(eq(sourceSubscriptions.id, existingSub.id));
      }

      logger.info(
        { userId, channelId, archetype: input.archetype, subscriptionId },
        "Feed setup complete"
      );

      return { channelId, subscriptionId };
    }),

  /**
   * Return the user's personal feed channel and its active subscriptions.
   * Optionally filter subscriptions by archetype.
   */
  getFeedChannel: protectedProcedure
    .input(
      z.object({
        archetype: z
          .enum([
            "leads",
            "hiring",
            "investors",
            "trends",
            "competitors",
            "press",
          ])
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId;

      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.userId, userId),
          eq(channels.channelType, ChannelType.FEED),
          eq(channels.feedScope, FeedScope.USER)
        ),
      });

      if (!channel) return { channel: null, subscriptions: [] };

      const subs = await db.query.sourceSubscriptions.findMany({
        where: and(
          drizzleSql`${sourceSubscriptions.feedId} = ${channel.id}`,
          eq(sourceSubscriptions.status, "active")
        ),
      });

      const filtered = input.archetype
        ? subs.filter(
            (s) =>
              (s.params as Record<string, unknown>)?.feedType ===
              input.archetype
          )
        : subs;

      return { channel, subscriptions: filtered };
    }),
});

/** Recursive node returned by getBranchTree — mirrors the frontend BranchNode shape */
export type BranchTreeNode = {
  channel: Channel;
  children: BranchTreeNode[];
};

/**
 * Helper: build branch tree structure
 */
function buildBranchTree(
  channels: Channel[],
  rootId: string
): BranchTreeNode | null {
  const root = channels.find((c) => c.id === rootId);
  if (!root) return null;

  const children = channels
    .filter((c) => c.parentChannelId === rootId)
    .map((child) => buildBranchTree(channels, child.id))
    .filter((n): n is BranchTreeNode => n !== null);

  return { channel: root, children };
}
