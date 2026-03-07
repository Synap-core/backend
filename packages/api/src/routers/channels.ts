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
  inArray,
  drizzleSql,
} from "@synap/database";
import {
  channels,
  messages,
  channelContextItems,
  ChannelType,
  ChannelStatus,
  ChannelAgentType,
  MessageRole,
  MessageAuthorType,
  ChannelContextObjectType,
  ChannelContextRelationshipType,
  proposals,
  ProposalStatus,
  users,
  workspaceMembers,
  mcpServers,
  sessions,
  SessionStatus,
} from "@synap/database/schema";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { validateExternalUrl } from "../utils/validate-url.js";
import { ensurePersonalChannel } from "../utils/personal-channel.js";
import { emitChatEvent } from "../utils/chat-realtime-broadcast.js";
import { MessageLinksRepository } from "@synap/database";
import {
  MessageLinkTargetType,
  MessageLinkRelationshipType,
} from "@synap-core/types";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import type { AIStep, HubResponse } from "@synap-core/types";
import type { Channel } from "@synap/database/schema";

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

export function invalidateMcpCache(workspaceId: string): void {
  mcpServerCache.delete(workspaceId);
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
 * Ensure a per-human AI agent user exists for the given (userId, workspaceId) pair.
 * Creates one if absent, then adds it as a workspace member (editor role).
 * Returns the agent user ID.
 */
async function ensureAgentUser(
  userId: string,
  workspaceId: string
): Promise<string> {
  // Try to find existing agent user for this human in this workspace
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(
      and(
        eq(users.userType, "agent"),
        eq(workspaceMembers.workspaceId, workspaceId),
        drizzleSql`${users.agentMetadata}->>'createdByUserId' = ${userId}`
      )
    )
    .limit(1);

  if (existing) return existing.id;

  // Create agent user row
  const agentId = randomUUID();
  const shortId = agentId.slice(0, 8);
  const [agentUser] = await db
    .insert(users)
    .values({
      id: agentId,
      email: `agent-orchestrator-${shortId}@synap.agent`,
      userType: "agent",
      kratosIdentityId: null,
      agentMetadata: { createdByUserId: userId, agentType: "orchestrator" },
    })
    .returning({ id: users.id });

  // Add as workspace member with editor role
  await db.insert(workspaceMembers).values({
    id: randomUUID(),
    workspaceId,
    userId: agentUser.id,
    role: "editor",
  });

  return agentUser.id;
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
export const channelsRouter = router({
  /**
   * Create a new channel.
   * When parentChannelId is provided, creates a branch channel.
   */
  createChannel: workspaceProcedure
    .input(
      z.object({
        parentChannelId: z.string().uuid().optional(),
        branchPurpose: z.string().optional(),
        agentId: z.string().optional(),
        agentType: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w:.-]+$/)
          .optional(),
        agentConfig: z.record(z.string(), z.any()).optional(),
        inheritContext: z.boolean().default(true),
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
            agentId: input.agentId || "orchestrator",
            agentType: input.agentType ?? ChannelAgentType.META,
            agentConfig: input.agentConfig,
            channelType: ChannelType.BRANCH,
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
      const [channel] = await db
        .insert(channels)
        .values({
          userId: ctx.userId,
          workspaceId: workspaceId ?? null,
          channelType: ChannelType.AI_THREAD,
          status: ChannelStatus.ACTIVE,
          agentId: input.agentId || "orchestrator",
          agentType: input.agentType ?? ChannelAgentType.META,
        })
        .returning();

      const channelId = channel.id;

      emitChatEvent({
        event: "channel:created",
        data: { channelId, userId: ctx.userId },
        workspaceId: workspaceId ?? null,
        userId: ctx.userId,
      });

      return { channelId, channel };
    }),

  /**
   * Create an external-import channel.
   *
   * Called either:
   *   a) directly by the user (manual import from settings)
   *   b) by proposals.approve when a hub-protocol `createExternalChannel` proposal is approved
   *
   * The channel stores the external platform conversation and lets the AI and user
   * interact with it inside the workspace. No AI auto-response on creation.
   */
  createExternalChannel: workspaceProcedure
    .input(
      z.object({
        externalSource: z.string(),
        externalChannelId: z.string(),
        title: z.string().min(1).max(255),
        externalParticipants: z.array(z.string()).optional(),
        initialMessage: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
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

      // Idempotency: check if a channel for this external source + ID already exists
      const existing = await db.query.channels.findFirst({
        where: and(
          eq(channels.workspaceId, workspaceId),
          eq(channels.externalSource, input.externalSource),
          eq(channels.externalChannelId, input.externalChannelId)
        ),
      });

      if (existing) {
        return { channelId: existing.id, status: "exists" as const };
      }

      const channelId = randomUUID();
      await db.insert(channels).values({
        id: channelId,
        userId: ctx.userId,
        workspaceId,
        channelType: ChannelType.EXTERNAL_IMPORT,
        status: ChannelStatus.ACTIVE,
        title: input.title,
        externalSource: input.externalSource,
        externalChannelId: input.externalChannelId,
        metadata: {
          externalParticipants: input.externalParticipants ?? [],
          ...(input.metadata ?? {}),
        },
      });

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
   * Create an A2AI (agent-to-agent) channel.
   *
   * A2AI channels enable async peer communication between AI agents without
   * requiring a human author. Both Synap IS and external agents (OpenClaw, etc.)
   * can post to and read from these channels.
   *
   * Visibility:
   *   "closed" — only named participants (agent user IDs) can post
   *   "open"   — discoverable by any agent; first post from a new agent triggers
   *              a lightweight proposal so the user can approve/deny the new participant
   *
   * Humans can observe and inject messages at any time.
   */
  createA2AIChannel: workspaceProcedure
    .input(
      z.object({
        topic: z.string().min(1).max(500),
        visibility: z.enum(["open", "closed"]).default("closed"),
        /** Agent user IDs that can post (required for closed, recommended for open) */
        participants: z.array(z.string().uuid()).optional(),
        agentType: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w:.-]+$/)
          .optional(),
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

      // Editor role or higher required to create A2AI channels (L-2)
      if (!["editor", "admin", "owner"].includes(ctx.workspaceRole ?? "")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Editor role or higher required to create A2AI channels",
        });
      }

      const channelId = randomUUID();
      await db.insert(channels).values({
        id: channelId,
        userId: ctx.userId,
        workspaceId,
        channelType: ChannelType.A2AI,
        status: ChannelStatus.ACTIVE,
        title: input.title ?? input.topic.slice(0, 80),
        agentId: "orchestrator",
        agentType: input.agentType ?? ChannelAgentType.DEFAULT,
        metadata: {
          topic: input.topic,
          visibility: input.visibility,
          participants: input.participants ?? [],
          a2aiStatus: "active",
        },
      });

      emitChatEvent({
        event: "channel:created",
        data: { channelId, userId: ctx.userId, channelType: ChannelType.A2AI },
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
        content: z.string().min(1),
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
        channelType: ChannelType.DOCUMENT_REVIEW,
        contextObjectType: "document",
        contextObjectId: input.documentId,
        status: ChannelStatus.ACTIVE,
        agentId: "orchestrator",
        agentType: ChannelAgentType.DEFAULT,
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
        content: z.string().min(1),
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
        channelType: ChannelType.ENTITY_COMMENTS,
        contextObjectType: "entity",
        contextObjectId: input.entityId,
        status: ChannelStatus.ACTIVE,
        agentId: "orchestrator",
        agentType: ChannelAgentType.DEFAULT,
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
    .input(
      z.object({
        /** When omitted, backend creates a new channel and returns its id. */
        channelId: z.string().uuid().optional(),
        content: z.string().min(1),
        workspaceId: z.string().uuid().optional(),
        agentType: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w:.-]+$/)
          .optional(),
        /** @mention handle, e.g. "cto" or "ai" — resolved to agentType for this call only */
        agentHandle: z.string().optional(),
        /** Originating channel ID when spawning a new AI_THREAD from a non-AI channel */
        parentChannelId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      let channelId = input.channelId;
      const content = input.content;
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
      const requestedAgentType = input.agentType;

      // Resolve @mention handle → agentType (for per-call override, not stored on channel)
      const mentionedAgentType =
        (input.agentHandle ? resolveAgentHandle(input.agentHandle) : null) ??
        extractMentionAgentType(content);

      // Route to channel when not provided
      if (!channelId) {
        if (!workspaceId && requestedAgentType !== "onboarding") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "workspaceId is required when sending a message without a thread",
          });
        }

        if (requestedAgentType === "onboarding") {
          // Onboarding flow: no workspace yet — create a dedicated ephemeral channel
          const [channel] = await db
            .insert(channels)
            .values({
              userId: ctx.userId,
              workspaceId: workspaceId ?? null,
              channelType: ChannelType.AI_THREAD,
              status: ChannelStatus.ACTIVE,
              agentId: "orchestrator",
              agentType: ChannelAgentType.ONBOARDING,
              parentChannelId: input.parentChannelId ?? null,
            })
            .returning();
          channelId = channel.id;
          emitChatEvent({
            event: "channel:created",
            data: { channelId, userId: ctx.userId },
            workspaceId: workspaceId ?? null,
            userId: ctx.userId,
          });
        } else {
          // All other cases: route to the user's personal AI timeline.
          // ensurePersonalChannel is idempotent — creates the channel on first call,
          // returns the existing one on all subsequent calls.
          if (workspaceId) {
            const membership = await db.query.workspaceMembers.findFirst({
              where: and(
                eq(workspaceMembers.workspaceId, workspaceId),
                eq(workspaceMembers.userId, ctx.userId)
              ),
            });
            if (!membership) {
              throw new TRPCError({
                code: "FORBIDDEN",
                message: "You are not a member of this workspace",
              });
            }
          }
          const personalChannel = await ensurePersonalChannel(
            ctx.userId,
            workspaceId!
          );
          channelId = personalChannel.id;
          // No channel:created event — channel already exists (or was just created
          // on workspace join). Either way the frontend already knows about it.
        }
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
      if (channel.workspaceId && channel.userId !== ctx.userId) {
        const membership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, channel.workspaceId),
            eq(workspaceMembers.userId, ctx.userId)
          ),
        });
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You do not have access to this channel",
          });
        }
      }

      // Get or create an active session for this channel so messages are session-scoped.
      // This is idempotent — the IS also calls getOrCreate, they'll both resolve to the same session.
      let activeSessionId: string | undefined;
      if (
        channel.channelType === ChannelType.AI_THREAD ||
        channel.channelType === ChannelType.BRANCH
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
            activeSessionId = newSessionId;
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
        userId: ctx.userId,
        previousHash: "",
        hash: userMessageHash,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
      });

      // Auto-provision agent user for this human+workspace pair (idempotent)
      let agentUserId: string | undefined;
      if (workspaceId) {
        try {
          agentUserId = await ensureAgentUser(ctx.userId, workspaceId);
        } catch (err) {
          // Non-critical — degrade gracefully
          console.error("Failed to ensure agent user:", err);
        }
      }

      // Resolve intelligence service dynamically
      const resolvedService = await resolveIntelligenceService({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId || undefined,
        capability: "chat",
      });

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

      // Effective agent type: @mention override → channel setting → default
      const effectiveAgentType =
        mentionedAgentType ?? channel.agentType ?? "meta";

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

      try {
        const stream = resolvedService.client.sendMessageStream({
          query: content,
          threadId: channelId,
          userId: ctx.userId,
          agentId: channel.agentId ?? "orchestrator",
          agentType: effectiveAgentType,
          // Personality overlay from channel — custom instructions, persona name, etc.
          agentConfig: (channel.agentConfig ?? undefined) as
            | Record<string, unknown>
            | undefined,
          workspaceId,
          // Link proposals created during this response to the triggering user message
          sourceMessageId: userMessageId,
          // Per-human AI agent user — enables full attribution for hub-protocol tool calls
          agentUserId: agentUserId ?? resolvedService.agentUserId,
          // MCP servers configured for this workspace
          mcpServers: mcpServersList,
        });

        for await (const chunk of stream) {
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
              userId: ctx.userId,
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
              userId: ctx.userId,
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
              userId: ctx.userId,
            });
          } else if (chunk.type === "complete") {
            if (chunk.data) {
              const data = chunk.data as Partial<HubResponse>;
              hubResponse = { ...hubResponse, ...data };
              // Collect proposals created by backend governance during this response
              const incoming = (data as any).createdProposals as
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
                userId: ctx.userId,
              });
            }

            emitChatEvent({
              event: "chat:stream",
              data: { threadId: channelId, type: "complete", isComplete: true },
              workspaceId: workspaceId ?? null,
              userId: ctx.userId,
            });
          }
        }
      } catch (streamError) {
        console.error(
          "Streaming error, falling back to non-streaming:",
          streamError
        );

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
          userId: ctx.userId,
        });

        try {
          hubResponse = await resolvedService.client.sendMessage({
            query: content,
            threadId: channelId,
            userId: ctx.userId,
            agentId: channel.agentId ?? "orchestrator",
            agentType: effectiveAgentType,
            workspaceId,
            sourceMessageId: userMessageId,
            agentUserId: agentUserId ?? resolvedService.agentUserId,
            mcpServers: mcpServersList,
          });
        } catch (fallbackError) {
          // Both stream and non-streaming fallback failed — Intelligence Hub is down
          // Save a service-unavailable message so the user isn't left with an orphaned user message
          fullContent =
            "The AI service is temporarily unavailable. Please try again in a moment.";
          emitChatEvent({
            event: "chat:stream:error",
            data: {
              threadId: channelId,
              error: "AI service unavailable",
              fallback: false,
            },
            workspaceId: workspaceId ?? null,
            userId: ctx.userId,
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
              userId: ctx.userId,
            });
          }
        }
      }

      // Save assistant message
      const assistantMessageId = randomUUID();
      const assistantMessageHash = createHash("sha256")
        .update(`${assistantMessageId}${fullContent}${userMessageHash}`)
        .digest("hex");

      // Derive auto-approved actions: tool calls in aiSteps not matched by a created proposal
      const effectiveAiSteps =
        aiSteps.length > 0 ? aiSteps : (hubResponse?.aiSteps ?? []);
      const proposalToolNameSet = new Set(
        createdProposals.map((cp) => cp.toolName)
      );
      const autoApprovedActions = effectiveAiSteps
        .filter(
          (s) =>
            s.type === "tool_call" &&
            s.toolName &&
            !proposalToolNameSet.has(s.toolName)
        )
        .map((s) => s.toolName as string)
        .filter((name, idx, arr) => arr.indexOf(name) === idx); // deduplicate

      const messageMetadata = {
        aiSteps: effectiveAiSteps,
        tokens: hubResponse?.usage?.totalTokens,
        proposalIds:
          createdProposals.length > 0
            ? createdProposals.map((cp) => cp.proposalId)
            : undefined,
        autoApprovedActions:
          autoApprovedActions.length > 0 ? autoApprovedActions : undefined,
        serviceId: resolvedService.serviceId,
      };

      await db.insert(messages).values({
        id: assistantMessageId,
        channelId,
        role: MessageRole.ASSISTANT,
        authorType: MessageAuthorType.AI_AGENT,
        content: fullContent,
        userId: ctx.userId,
        previousHash: userMessageHash,
        hash: assistantMessageHash,
        metadata: messageMetadata as any,
        ...(activeSessionId ? { sessionId: activeSessionId } : {}),
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
          .catch(() => {}); // silent — non-critical
      }

      // Create entities via event chain
      const createdEntities = [];
      const entities = hubResponse?.entities || [];

      if (entities.length > 0) {
        try {
          const { getBoss } = await import("@synap/jobs");

          for (const entity of entities) {
            await getBoss().send("entity-embedding", {
              type: entity.type,
              title: entity.title,
              preview: entity.description,
              userId: ctx.userId,
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
            userId: ctx.userId,
            timestamp: new Date(),
            previousHash: userMessageHash,
            hash: assistantMessageHash,
            metadata: messageMetadata,
          },
          userId: ctx.userId,
        },
        workspaceId: workspaceId ?? null,
        userId: ctx.userId,
      });

      // Outbound relay: for EXTERNAL_IMPORT channels, forward the AI response back to
      // the external platform via OpenClaw's OpenAI-compatible endpoint.
      // Non-blocking — failure here must never affect the response to the frontend.
      if (
        channel.channelType === ChannelType.EXTERNAL_IMPORT &&
        channel.externalSource &&
        channel.externalChannelId &&
        fullContent
      ) {
        relayToExternalChannel({
          workspaceId: workspaceId || channel.workspaceId || undefined,
          userId: ctx.userId,
          externalSource: channel.externalSource,
          externalChannelId: channel.externalChannelId,
          content: fullContent,
        }).catch((err) => {
          console.error(
            "[channels] Outbound relay to external channel failed:",
            err
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
            userId: ctx.userId,
            parentChannelId: channelId,
            branchedFromMessageId: assistantMessageId,
            branchPurpose:
              branchDecision.suggestedPurpose || branchDecision.reason,
            agentId: branchDecision.suggestedAgentType || "research-agent",
            channelType: ChannelType.BRANCH,
            status: ChannelStatus.ACTIVE,
          })
          .returning();

        branchChannel = branch;
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
      if (
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
        channelType: z.enum(["main", "branch", "ai_thread"]).optional(),
        limit: z.number().min(1).max(100).default(20),
        contextObjectId: z.string().uuid().optional(),
        contextObjectType: z.enum(["entity", "document", "view"]).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [eq(channels.userId, ctx.userId)];

      if (input.workspaceId !== undefined) {
        conditions.push(eq(channels.workspaceId, input.workspaceId));
      }

      if (input.channelType) {
        const ct =
          input.channelType === "branch"
            ? ChannelType.BRANCH
            : ChannelType.AI_THREAD;
        conditions.push(eq(channels.channelType, ct));
      }

      if (input.contextObjectId !== undefined) {
        conditions.push(eq(channels.contextObjectId, input.contextObjectId));
      }

      if (input.contextObjectType !== undefined) {
        conditions.push(
          eq(channels.contextObjectType, input.contextObjectType)
        );
      }

      const allChannels = await db.query.channels.findMany({
        where: and(...conditions),
        orderBy: [desc(channels.updatedAt)],
        limit: input.limit,
      });

      if (allChannels.length === 0) {
        return { channels: [] };
      }

      const channelIds = allChannels.map((c) => c.id);
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

      const channelsWithFlags = allChannels.map((c) => ({
        ...c,
        hasAssistantMessage: channelIdsWithAssistant.has(c.id),
        origin: (c.metadata as { origin?: string } | null)?.origin ?? "chat",
      }));

      return { channels: channelsWithFlags };
    }),

  /**
   * Backward-compat alias for listChannels (used by Electron client).
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        channelType: z.enum(["main", "branch", "ai_thread"]).optional(),
        limit: z.number().min(1).max(100).default(20),
        contextObjectId: z.string().uuid().optional(),
        contextObjectType: z.enum(["entity", "document", "view"]).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const conditions: any[] = [eq(channels.userId, ctx.userId)];

      if (input.workspaceId !== undefined) {
        conditions.push(eq(channels.workspaceId, input.workspaceId));
      }

      if (input.channelType) {
        const ct =
          input.channelType === "branch"
            ? ChannelType.BRANCH
            : ChannelType.AI_THREAD;
        conditions.push(eq(channels.channelType, ct));
      }

      if (input.contextObjectId !== undefined) {
        conditions.push(eq(channels.contextObjectId, input.contextObjectId));
      }

      if (input.contextObjectType !== undefined) {
        conditions.push(
          eq(channels.contextObjectType, input.contextObjectType)
        );
      }

      const allChannels = await db.query.channels.findMany({
        where: and(...conditions),
        orderBy: [desc(channels.updatedAt)],
        limit: input.limit,
      });

      if (allChannels.length === 0) {
        return { channels: [] };
      }

      const channelIds = allChannels.map((c) => c.id);
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

      const channelsWithFlags = allChannels.map((c) => ({
        ...c,
        hasAssistantMessage: channelIdsWithAssistant.has(c.id),
        origin: (c.metadata as { origin?: string } | null)?.origin ?? "chat",
      }));

      return { channels: channelsWithFlags };
    }),

  /**
   * Get or create the user's personal AI timeline for the given workspace.
   * Returns the channel — creates it if it doesn't exist yet (idempotent).
   * Used by command palette and any AI trigger that has no explicit channelId.
   */
  getPersonalChannel: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const channel = await ensurePersonalChannel(
        ctx.userId,
        input.workspaceId
      );
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

      if (!branch || branch.channelType !== "branch") {
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
      if (
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
        agentId: z.string().optional(),
        agentType: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[\w:.-]+$/)
          .optional(),
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
          agentId: input.agentId,
          agentType: input.agentType,
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
        (c) => c.status === "active" && c.channelType === "branch"
      );
      const mergedBranches = allChannels.filter(
        (c) => c.status === "merged" && c.channelType === "branch"
      );

      return {
        tree,
        flatBranches: allChannels.filter((c) => c.channelType === "branch"),
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
