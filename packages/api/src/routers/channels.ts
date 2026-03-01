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
  workspaces,
} from "@synap/database/schema";
import type { WorkspaceSettings } from "@synap/database/schema";
import { resolveIntelligenceService } from "../utils/intelligence-routing.js";
import { validateExternalUrl } from "../utils/validate-url.js";
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
  createThread: workspaceProcedure
    .input(
      z.object({
        parentThreadId: z.string().uuid().optional(),
        branchPurpose: z.string().optional(),
        agentId: z.string().optional(),
        agentType: z
          .enum([
            "meta",
            "default",
            "prompting",
            "knowledge-search",
            "code",
            "writing",
            "action",
            "onboarding",
          ])
          .optional(),
        agentConfig: z.record(z.string(), z.any()).optional(),
        inheritContext: z.boolean().default(true),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = ctx.workspaceId;

      // If branching, verify parent channel is in same workspace
      if (input.parentThreadId) {
        const parentChannel = await db.query.channels.findFirst({
          where: eq(channels.id, input.parentThreadId),
        });

        if (!parentChannel) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Parent channel not found",
          });
        }
      }

      // Branch channel
      if (input.parentThreadId) {
        const branchChannelId = randomUUID();

        await db
          .insert(channels)
          .values({
            id: branchChannelId,
            userId: ctx.userId,
            workspaceId: workspaceId ?? null,
            parentChannelId: input.parentThreadId,
            branchPurpose: input.branchPurpose,
            agentId: input.agentId || "orchestrator",
            agentType: input.agentType
              ? (input.agentType as ChannelAgentType)
              : ChannelAgentType.DEFAULT,
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
            parentChannelId: input.parentThreadId,
          },
          workspaceId: workspaceId ?? null,
          userId: ctx.userId,
        });

        return {
          threadId: branchChannelId,
          status: "created",
          message: "Branch created",
        };
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
          agentType: input.agentType
            ? (input.agentType as ChannelAgentType)
            : ChannelAgentType.DEFAULT,
        })
        .returning();

      const channelId = channel.id;

      emitChatEvent({
        event: "channel:created",
        data: { channelId, userId: ctx.userId },
        workspaceId: workspaceId ?? null,
        userId: ctx.userId,
      });

      return { threadId: channelId, thread: channel };
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
          .enum([
            "default",
            "meta",
            "prompting",
            "knowledge-search",
            "code",
            "writing",
            "action",
          ])
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
        agentType:
          (input.agentType as ChannelAgentType) ?? ChannelAgentType.DEFAULT,
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

      return { threadId: channelId, messageId: userMessageId };
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

      return { threadId: channelId, messageId: userMessageId };
    }),

  /**
   * Send message to Intelligence Hub and get AI response (with streaming).
   * When threadId is omitted, the backend creates a new channel and attaches the message.
   */
  sendMessage: protectedProcedure
    .input(
      z.object({
        /** When omitted, backend creates a new channel and returns its id. */
        threadId: z.string().uuid().optional(),
        content: z.string().min(1),
        workspaceId: z.string().uuid().optional(),
        agentType: z
          .enum([
            "meta",
            "default",
            "prompting",
            "knowledge-search",
            "code",
            "writing",
            "action",
            "onboarding",
          ])
          .optional(),
        /** @mention handle, e.g. "cto" or "ai" — resolved to agentType for this call only */
        agentHandle: z.string().optional(),
        /** Originating channel ID when spawning a new AI_THREAD from a non-AI channel */
        parentChannelId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      let channelId = input.threadId;
      const content = input.content;
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
      const requestedAgentType = input.agentType;

      // Resolve @mention handle → agentType (for per-call override, not stored on channel)
      const mentionedAgentType =
        (input.agentHandle ? resolveAgentHandle(input.agentHandle) : null) ??
        extractMentionAgentType(content);

      // Create channel when not provided
      if (!channelId) {
        if (!workspaceId && requestedAgentType !== "onboarding") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "workspaceId is required when sending a message without a thread",
          });
        }
        const channelAgentType = requestedAgentType
          ? (requestedAgentType as ChannelAgentType)
          : ChannelAgentType.DEFAULT;
        const [channel] = await db
          .insert(channels)
          .values({
            userId: ctx.userId,
            workspaceId: workspaceId ?? null,
            channelType: ChannelType.AI_THREAD,
            status: ChannelStatus.ACTIVE,
            agentId: "orchestrator",
            agentType: channelAgentType,
            parentChannelId: input.parentChannelId ?? null,
            title: input.agentHandle ? `@${input.agentHandle}` : undefined,
          })
          .returning();
        channelId = channel.id;
        emitChatEvent({
          event: "channel:created",
          data: { channelId, userId: ctx.userId },
          workspaceId: workspaceId ?? null,
          userId: ctx.userId,
        });
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

      // Fetch workspace MCP server configs (non-blocking, degrade gracefully)
      let mcpServers: WorkspaceSettings["mcpServers"] | undefined;
      if (workspaceId) {
        try {
          const ws = await db.query.workspaces.findFirst({
            where: eq(workspaces.id, workspaceId),
            columns: { settings: true },
          });
          mcpServers = (ws?.settings as WorkspaceSettings)?.mcpServers;
        } catch {
          // Non-critical — agents still work without MCP servers
        }
      }
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
        mcpServers = mcpServers
          ? [
              ...mcpServers.filter((s) => s.id !== resolvedService.serviceId),
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
          workspaceId,
          // Link proposals created during this response to the triggering user message
          sourceMessageId: userMessageId,
          // Per-human AI agent user — enables full attribution for hub-protocol tool calls
          agentUserId: agentUserId ?? resolvedService.agentUserId,
          // MCP servers configured for this workspace
          mcpServers,
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

        hubResponse = await resolvedService.client.sendMessage({
          query: content,
          threadId: channelId,
          userId: ctx.userId,
          agentId: channel.agentId ?? "orchestrator",
          agentType: effectiveAgentType,
          workspaceId,
          sourceMessageId: userMessageId,
          agentUserId: agentUserId ?? resolvedService.agentUserId,
          mcpServers,
        });

        fullContent = hubResponse.content || "";

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
      });

      // Create entities via event chain
      const createdEntities = [];
      const entities = hubResponse?.entities || [];

      if (entities.length > 0) {
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
        threadId: channelId,
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
  listThreads: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        threadType: z.enum(["main", "branch", "ai_thread"]).optional(),
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

      if (input.threadType) {
        const channelType =
          input.threadType === "branch"
            ? ChannelType.BRANCH
            : ChannelType.AI_THREAD;
        conditions.push(eq(channels.channelType, channelType));
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
        return { threads: [] };
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

      const threadsWithFlags = allChannels.map((c) => ({
        ...c,
        hasAssistantMessage: channelIdsWithAssistant.has(c.id),
        origin: (c.metadata as { origin?: string } | null)?.origin ?? "chat",
      }));

      return { threads: threadsWithFlags };
    }),

  /**
   * Get branch channels for a parent channel
   */
  getBranches: protectedProcedure
    .input(
      z.object({
        parentThreadId: z.string().uuid(),
      })
    )
    .query(async ({ input }) => {
      const branches = await db.query.channels.findMany({
        where: eq(channels.parentChannelId, input.parentThreadId),
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
            totalThreads: 0,
            activeThreads: 0,
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
          totalThreads: allChannels.length,
          activeThreads: activeChannels,
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
        throw new Error("Branch not found");
      }

      if (!branch.parentChannelId) {
        throw new Error("Branch has no parent channel");
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
  getThread: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        includeContext: z.boolean().default(true),
        includeBranches: z.boolean().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.threadId),
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
          where: eq(channelContextItems.channelId, input.threadId),
        });
      }

      // Get branch tree if requested
      let branchTree: any = null;
      if (input.includeBranches) {
        const allBranches = await db.query.channels.findMany({
          where: or(
            eq(channels.id, input.threadId),
            eq(channels.parentChannelId, input.threadId)
          ),
        });

        branchTree = buildBranchTree(allBranches, input.threadId);
      }

      return {
        thread: channel,
        contextItems: input.includeContext ? contextItems : undefined,
        branchTree: input.includeBranches ? branchTree : undefined,
      };
    }),

  /**
   * Update channel metadata
   */
  updateThread: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
        title: z.string().optional(),
        agentId: z.string().optional(),
        agentType: z
          .enum([
            "meta",
            "default",
            "prompting",
            "knowledge-search",
            "code",
            "writing",
            "action",
            "onboarding",
          ])
          .optional(),
        agentConfig: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.threadId),
          eq(channels.userId, ctx.userId)
        ),
      });

      if (!channel) {
        throw new Error("Channel not found");
      }

      await db
        .update(channels)
        .set({
          title: input.title,
          agentId: input.agentId,
          agentType: input.agentType
            ? (input.agentType as ChannelAgentType)
            : undefined,
          agentConfig: input.agentConfig,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.threadId));

      emitChatEvent({
        event: "channel:updated",
        data: { channelId: input.threadId, userId: ctx.userId },
        workspaceId: channel.workspaceId ?? ctx.workspaceId ?? null,
        userId: ctx.userId,
      });

      return {
        status: "updated",
        threadId: input.threadId,
      };
    }),

  /**
   * Archive channel (soft delete)
   */
  archiveThread: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.threadId),
          eq(channels.userId, ctx.userId)
        ),
      });

      if (!channel) {
        throw new Error("Channel not found");
      }

      await db
        .update(channels)
        .set({
          status: ChannelStatus.ARCHIVED,
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.threadId));

      emitChatEvent({
        event: "channel:archived",
        data: { channelId: input.threadId, userId: ctx.userId },
        workspaceId: channel.workspaceId ?? ctx.workspaceId ?? null,
        userId: ctx.userId,
      });

      return {
        status: "archived",
        threadId: input.threadId,
      };
    }),

  /**
   * Get branch tree structure (not flat list)
   */
  getBranchTree: protectedProcedure
    .input(
      z.object({
        rootThreadId: z.string().uuid(),
      })
    )
    .query(async ({ input, ctx }) => {
      const allChannels = await db.query.channels.findMany({
        where: and(
          or(
            eq(channels.id, input.rootThreadId),
            eq(channels.parentChannelId, input.rootThreadId)
          ),
          eq(channels.userId, ctx.userId)
        ),
      });

      const tree = buildBranchTree(allChannels, input.rootThreadId);

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
  getThreadContext: protectedProcedure
    .input(
      z.object({
        threadId: z.string().uuid(),
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
          eq(channels.id, input.threadId),
          eq(channels.userId, ctx.userId)
        ),
      });

      if (!channel) {
        throw new Error("Channel not found");
      }

      const conditions: any[] = [
        eq(channelContextItems.channelId, input.threadId),
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
});

/** Recursive node returned by getBranchTree — mirrors the frontend BranchNode shape */
type BranchTreeNode = {
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
