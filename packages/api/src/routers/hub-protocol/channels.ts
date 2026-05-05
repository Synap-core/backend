/**
 * Hub Protocol — Channels Router
 *
 * Allows external intelligence services (OpenClaw, etc.) to interact with channels
 * in the Synap workspace. All write operations go through governance:
 *
 *   AI proposes createExternalChannel
 *     → checkPermissionOrPropose
 *     → proposal created (PENDING) in user's inbox
 *   User approves
 *     → proposals.approve handler executes channelsRouter.createExternalChannel
 *
 * The "channel.create_external" action is NOT in the default autoApproveFor
 * whitelist — users must explicitly approve importing external conversations.
 * Workspaces can opt in by adding "channel.create_external" to autoApproveFor.
 *
 * A2AI procedures are for agent-to-agent async communication. OpenClaw uses these
 * to post messages into shared A2AI channels and poll for Synap IS responses.
 */

import { z } from "zod";
import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { checkPermissionOrPropose } from "../../utils/permission-check.js";
import { randomUUID } from "crypto";
import { createHash } from "crypto";
import { db, eq, and, gt } from "@synap/database";
import {
  agents,
  channels,
  messages,
  workspaceMembers,
  ChannelType,
  MessageRole,
  MessageAuthorType,
} from "@synap/database/schema";
import { AI_CHANNEL_FAMILY_VALUES } from "@synap-core/types";
import { resolveAiChannelByFamily } from "../../utils/resolve-ai-channel-family.js";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";
import { emitTyped } from "../../utils/event-emit.js";
import { makeExcerpt } from "../../utils/excerpt.js";
import { EventNames } from "@synap-core/types/events";
import type { OpenClawPlatform } from "@synap-core/types/events";
import { resolveIntelligenceService } from "../../utils/intelligence-routing.js";
import { checkHubRateLimit } from "../../utils/hub-protocol-rate-limit.js";
import {
  getBoss,
  A2AI_TRIGGER_QUEUE,
  A2AI_TRIGGER_JOB_OPTIONS,
} from "@synap/jobs";
import type { A2AIResponseTriggerData } from "@synap/jobs";
import { TRPCError } from "@trpc/server";

/**
 * Sources we can map straight to {@link OpenClawPlatform} for the
 * `openclaw:message:received` realtime event. Sources outside this set still
 * land in DB normally; the viz emit is silently skipped (the event payload's
 * `platform` enum is closed and we'd rather drop than misrepresent).
 *
 * TODO(eve-channels): extend the registry's OpenClawPlatform union if/when
 * slack/email/sms become first-class bridge platforms.
 */
const OPENCLAW_PLATFORM_MAP: Record<string, OpenClawPlatform> = {
  telegram: "telegram",
  whatsapp: "whatsapp",
  discord: "discord",
};

const EXTERNAL_SOURCES = [
  "whatsapp",
  "telegram",
  "slack",
  "discord",
  "email",
  "sms",
  "teams",
  "imessage",
  "github",
  "linear",
  "notion",
  "other",
] as const;

export type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

/**
 * Verify that agentUserId is a member of the target workspace.
 * Prevents one workspace's agent from posting into another workspace's channels.
 * Returns the effective userId to use for attribution (agentUserId if valid, else fallback).
 */
async function assertAgentInWorkspace(
  agentUserId: string | undefined,
  workspaceId: string,
  fallbackUserId: string
): Promise<string> {
  if (!agentUserId) return fallbackUserId;
  const member = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.userId, agentUserId),
      eq(workspaceMembers.workspaceId, workspaceId)
    ),
  });
  if (!member) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "agentUserId is not a member of the specified workspace",
    });
  }
  return agentUserId;
}

export const channelsRouter = router({
  /**
   * Resolve or create an AI channel from structural family.
   * Canonical contract used by hub/rest adapters.
   */
  resolveAiChannel: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid().optional(),
        family: z.enum(AI_CHANNEL_FAMILY_VALUES),
        agentId: z.string().uuid().optional(),
        contextObjectId: z.string().uuid().optional(),
        contextObjectType: z.enum(["entity", "document", "view"]).optional(),
        parentChannelId: z.string().uuid().optional(),
        branchPurpose: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const channel = await resolveAiChannelByFamily({
        userId: input.userId,
        workspaceId: input.workspaceId,
        family: input.family,
        agentId: input.agentId,
        contextObjectId: input.contextObjectId,
        contextObjectType: input.contextObjectType,
        parentChannelId: input.parentChannelId,
        branchPurpose: input.branchPurpose,
      });
      return { channel };
    }),

  /**
   * Propose creating an external-import channel.
   * Requires: hub-protocol.write scope
   *
   * This wraps an external conversation (WhatsApp chat, Slack DM, email thread, etc.)
   * as a Synap channel of type EXTERNAL, giving the AI and user a unified
   * view of the conversation inside the workspace.
   *
   * Always creates a pending proposal — user approves in inbox.
   * Approved via proposals.approve → executes the actual channel INSERT.
   */
  createExternalChannel: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        /** The human user who should approve this (agent acts on behalf of) */
        userId: z.string(),
        workspaceId: z.string().uuid(),
        /**
         * The platform this conversation originated from.
         * Stored as channels.externalSource.
         */
        externalSource: z.enum(EXTERNAL_SOURCES),
        /**
         * Platform-native conversation ID (phone number, channel ID, thread ID…).
         * Used for idempotency — prevents creating duplicate channels for the same conversation.
         */
        externalChannelId: z.string(),
        /** Human-readable title for the channel (e.g. "WhatsApp: Alice", "Slack #general") */
        title: z.string().min(1).max(255),
        /**
         * Optional: platform-native participants (phone numbers, handles, emails…).
         * Stored in channel.metadata.externalParticipants.
         */
        externalParticipants: z.array(z.string()).optional(),
        /** Initial message content to pre-seed the channel (optional) */
        initialMessage: z.string().optional(),
        /** Extra metadata for the service to store (platform-specific) */
        metadata: z.record(z.string(), z.unknown()).optional(),
        /** Optional: agent reasoning shown in the proposal inbox item */
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const proposalId = randomUUID();

      const perm = await checkPermissionOrPropose({
        userId: input.userId,
        workspaceId: input.workspaceId,
        subjectType: "channel",
        action: "create_external",
        data: {
          id: proposalId,
          externalSource: input.externalSource,
          externalChannelId: input.externalChannelId,
          title: input.title,
          externalParticipants: input.externalParticipants,
          initialMessage: input.initialMessage,
          metadata: input.metadata,
        },
        reasoning: input.reasoning,
      });

      if ("denied" in perm && perm.denied) {
        return {
          status: "denied" as const,
          reason: perm.reason,
        };
      }

      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          proposalId: perm.proposalId,
          summary: perm.summary,
          reasoning: perm.reasoning,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          message: `Proposal created — user must approve importing ${input.externalSource} conversation "${input.title}".`,
        };
      }

      // Auto-approved: execute directly (only if workspace opted in via autoApproveFor)
      return {
        status: "approved" as const,
        channelId: proposalId, // actual channel creation happens via the shared helper
        message: "Channel import auto-approved.",
      };
    }),

  /**
   * Send a message to an existing external-import channel (hot path).
   * Requires: hub-protocol.write scope
   *
   * Used by OpenClaw to relay incoming Telegram/WhatsApp messages into a channel
   * that was previously approved by the user. No proposal needed since the channel
   * already exists (it was approved when created via createExternalChannel).
   *
   * This triggers Synap IS to auto-respond so the user can reply from within Synap.
   */
  sendExternalMessage: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        /** Agent user ID representing OpenClaw in Synap */
        agentUserId: z.string().optional(),
        workspaceId: z.string().uuid(),
        externalSource: z.enum(EXTERNAL_SOURCES),
        /** Platform-native conversation ID — used to find the existing channel */
        externalChannelId: z.string(),
        /** Display name of the sender on the external platform */
        senderName: z.string(),
        content: z.string().min(1),
        /** ISO8601 original timestamp of the message on the external platform */
        timestamp: z.string().datetime().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      checkHubRateLimit(ctx.apiKeyId, "sendExternalMessage");

      // Verify agentUserId is a member of the workspace (prevents cross-workspace posting)
      if (input.agentUserId) {
        await assertAgentInWorkspace(
          input.agentUserId,
          input.workspaceId,
          ctx.userId ?? input.agentUserId
        );
      }

      // Find the approved channel
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.externalSource, input.externalSource),
          eq(channels.externalChannelId, input.externalChannelId),
          eq(channels.channelType, ChannelType.EXTERNAL)
        ),
      });

      if (!channel) {
        // Channel doesn't exist yet — caller must use createExternalChannel first
        return { status: "no_channel" as const };
      }

      const messageId = randomUUID();
      const contentForHash = `${messageId}${input.content}`;
      const hash = createHash("sha256").update(contentForHash).digest("hex");

      await db.insert(messages).values({
        id: messageId,
        channelId: channel.id,
        role: MessageRole.USER,
        authorType: MessageAuthorType.EXTERNAL,
        content: input.content,
        userId: channel.userId,
        externalSource: input.externalSource,
        previousHash: "",
        hash,
        metadata: {
          senderName: input.senderName,
          originalTimestamp: input.timestamp,
          ...(input.metadata ?? {}),
        } as Record<
          string,
          unknown
        > as (typeof messages.$inferInsert)["metadata"],
      });

      await db
        .update(channels)
        .set({ updatedAt: new Date() })
        .where(eq(channels.id, channel.id));

      emitChatEvent({
        event: EventNames.CHAT_MESSAGE,
        data: {
          threadId: channel.id,
          message: {
            id: messageId,
            threadId: channel.id,
            role: MessageRole.USER,
            content: input.content,
            userId: channel.userId,
            timestamp: new Date(),
            previousHash: "",
            hash,
            metadata: {
              externalSource: input.externalSource,
              senderName: input.senderName,
            },
          },
          userId: channel.userId,
        },
        workspaceId: channel.workspaceId ?? null,
        userId: channel.userId,
      });

      // Phase 3B: feed the eve-dashboard channels viz. We only emit when the
      // external source maps to a known OpenClawPlatform — see
      // {@link OPENCLAW_PLATFORM_MAP}. Privacy gating is enforced at the
      // consumer; the excerpt is truncated here purely to bound payload size.
      const openclawPlatform = OPENCLAW_PLATFORM_MAP[input.externalSource];
      if (openclawPlatform) {
        void emitTyped(
          "openclaw:message:received",
          {
            channelId: channel.id,
            messageId,
            platform: openclawPlatform,
            excerpt: makeExcerpt(input.content),
            receivedAt: new Date().toISOString(),
          },
          {
            workspaceId: channel.workspaceId ?? undefined,
            channelId: channel.id,
            userId: channel.userId,
          }
        ).catch((err) => {
          console.warn(
            "[hub-protocol] openclaw:message:received emit failed",
            err
          );
        });
      }

      return {
        status: "received" as const,
        messageId,
        channelId: channel.id,
      };
    }),

  /**
   * Post a message into an A2AI channel from an external agent (e.g. OpenClaw).
   * Requires: hub-protocol.write scope
   *
   * Governance rules:
   *   - closed channels: agentUserId must be in metadata.participants → denied if not
   *   - open channels:   first post from a new agent → lightweight "a2ai.join" proposal
   *                      subsequent posts from known participants → auto-approved
   *
   * After inserting the message, emits a socket event that triggers Synap IS response.
   */
  postToA2AIChannel: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        agentUserId: z.string(),
        channelId: z.string().uuid(),
        workspaceId: z.string().uuid(),
        content: z.string().min(1),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      checkHubRateLimit(ctx.apiKeyId, "postToA2AIChannel");
      // Verify agentUserId is a member of the workspace
      await assertAgentInWorkspace(
        input.agentUserId,
        input.workspaceId,
        ctx.userId ?? input.agentUserId
      );

      // Verify channel exists and is A2AI type
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.channelType, ChannelType.AGENT_COLLAB)
        ),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "A2AI channel not found",
        });
      }

      const channelMeta = (channel.metadata ?? {}) as {
        visibility?: "open" | "closed";
        participants?: string[];
        topic?: string;
      };

      const visibility = channelMeta.visibility ?? "closed";
      const participants: string[] = channelMeta.participants ?? [];
      const isKnownParticipant = participants.includes(input.agentUserId);

      // Enforce closed channel access
      if (visibility === "closed" && !isKnownParticipant) {
        return {
          status: "denied" as const,
          reason: "Agent is not a participant in this closed A2AI channel.",
        };
      }

      // Open channel: first post from new agent → propose joining
      if (visibility === "open" && !isKnownParticipant) {
        // Find the human owner of this workspace for the proposal
        const userId = channel.userId;

        const perm = await checkPermissionOrPropose({
          userId,
          agentUserId: input.agentUserId,
          workspaceId: input.workspaceId,
          subjectType: "a2ai",
          action: "join",
          data: {
            channelId: input.channelId,
            agentUserId: input.agentUserId,
            topic: channelMeta.topic,
          },
          reasoning: `Agent ${input.agentUserId} wants to join A2AI channel "${channel.title ?? channelMeta.topic}"`,
        });

        if ("proposalId" in perm) {
          return {
            status: "proposed" as const,
            proposalId: perm.proposalId,
            summary: perm.summary,
            reasoning: perm.reasoning,
            reviewPath: perm.reviewPath,
            reviewUrl: perm.reviewUrl,
            message: "Waiting for user approval to join this A2AI channel.",
          };
        }

        if ("denied" in perm && perm.denied) {
          return { status: "denied" as const, reason: perm.reason };
        }

        // Auto-approved: add to participants
        const updatedParticipants = [...participants, input.agentUserId];
        await db
          .update(channels)
          .set({
            metadata: { ...channelMeta, participants: updatedParticipants },
            updatedAt: new Date(),
          })
          .where(eq(channels.id, input.channelId));
      }

      // Insert the message
      const messageId = randomUUID();
      const hash = createHash("sha256")
        .update(`${messageId}${input.content}`)
        .digest("hex");

      await db.insert(messages).values({
        id: messageId,
        channelId: input.channelId,
        role: MessageRole.USER,
        authorType: MessageAuthorType.AI_AGENT,
        content: input.content,
        userId: channel.userId, // channel owner as user context
        previousHash: "",
        hash,
        metadata: {
          agentUserId: input.agentUserId,
          source: "hub-protocol",
          ...(input.metadata ?? {}),
        } as Record<
          string,
          unknown
        > as (typeof messages.$inferInsert)["metadata"],
      });

      await db
        .update(channels)
        .set({ updatedAt: new Date() })
        .where(eq(channels.id, input.channelId));

      // Emit — triggers Synap IS to respond
      emitChatEvent({
        event: EventNames.CHAT_MESSAGE,
        data: {
          threadId: input.channelId,
          message: {
            id: messageId,
            threadId: input.channelId,
            role: MessageRole.USER,
            content: input.content,
            userId: channel.userId,
            timestamp: new Date(),
            previousHash: "",
            hash,
            metadata: { agentUserId: input.agentUserId },
          },
          userId: channel.userId,
          triggerAI: true, // hint for any real-time listeners
        },
        workspaceId: input.workspaceId ?? null,
        userId: channel.userId,
      });

      // Queue Synap IS response via pg-boss (retryLimit:3, replaces fire-and-forget)
      if (channel.workspaceId) {
        try {
          const resolvedService = await resolveIntelligenceService({
            userId: channel.userId,
            workspaceId: channel.workspaceId,
            capability: "chat",
          });

          const jobData: A2AIResponseTriggerData = {
            channelId: input.channelId,
            userMessageId: messageId,
            content: input.content,
            userId: channel.userId,
            workspaceId: channel.workspaceId,
            agentType: "meta",
            sourceAgentUserId: input.agentUserId,
            serviceUrl: resolvedService.endpoint,
            serviceApiKey: resolvedService.serviceApiKey,
            serviceId: resolvedService.serviceId,
            agentUserId: resolvedService.agentUserId,
          };

          await getBoss().send(
            A2AI_TRIGGER_QUEUE,
            jobData,
            A2AI_TRIGGER_JOB_OPTIONS
          );
        } catch (err) {
          console.error(
            "[hub-protocol] Failed to queue A2AI response trigger:",
            err
          );
        }
      }

      return {
        status: "sent" as const,
        messageId,
      };
    }),

  /**
   * Poll an A2AI channel for new messages since a given timestamp.
   * Requires: hub-protocol.read scope
   *
   * Used by OpenClaw to check for Synap IS responses without holding a connection open.
   * Returns messages in ascending order (oldest first).
   */
  pollA2AIChannel: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        channelId: z.string().uuid(),
        /** ISO8601 — returns messages after this timestamp */
        since: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      })
    )
    .query(async ({ input, ctx }) => {
      checkHubRateLimit(ctx.apiKeyId, "pollA2AIChannel");

      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          eq(channels.channelType, ChannelType.AGENT_COLLAB)
        ),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "A2AI channel not found",
        });
      }

      // Authorization: only the channel owner or known participants may poll.
      // For open channels, a prior post from the caller also grants read access.
      const channelMeta = (channel.metadata ?? {}) as {
        visibility?: "open" | "closed";
        participants?: string[];
      };
      const isOwner = channel.userId === ctx.userId;
      const participants: string[] = channelMeta.participants ?? [];
      const isParticipant = ctx.userId
        ? participants.includes(ctx.userId)
        : false;

      if (!isOwner && !isParticipant) {
        if ((channelMeta.visibility ?? "closed") === "closed") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not a participant of this channel",
          });
        }
        // Open channel: allow if caller has previously posted
        const priorPost = ctx.userId
          ? await db.query.messages.findFirst({
              where: and(
                eq(messages.channelId, input.channelId),
                eq(messages.userId, ctx.userId)
              ),
            })
          : null;
        if (!priorPost) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Not a participant of this channel",
          });
        }
      }

      const sinceDate = input.since ? new Date(input.since) : undefined;

      const rows = await db.query.messages.findMany({
        where: sinceDate
          ? and(
              eq(messages.channelId, input.channelId),
              gt(messages.timestamp, sinceDate)
            )
          : eq(messages.channelId, input.channelId),
        orderBy: (t, { asc }) => asc(t.timestamp),
        limit: input.limit + 1, // fetch one extra to detect hasMore
      });

      const hasMore = rows.length > input.limit;
      const result = hasMore ? rows.slice(0, input.limit) : rows;

      return {
        messages: result.map((m) => ({
          id: m.id,
          role: m.role,
          authorType: m.authorType,
          content: m.content,
          metadata: m.metadata,
          timestamp: m.timestamp.toISOString(),
        })),
        hasMore,
      };
    }),

  /**
   * Get or create the user's personal AI channel for a workspace.
   * Requires: hub-protocol.write scope (creates the channel if it doesn't exist)
   *
   * Idempotent — returns existing channel if already created.
   * Used by skill triggers that need a channelId to post into.
   */
  ensurePersonal: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        userId: z.string(),
        workspaceId: z.string().uuid(),
        /** Agent ID to create/retrieve the thread for. Defaults to orchestrator if omitted. */
        agentId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      let resolvedAgentId = input.agentId;
      if (!resolvedAgentId) {
        const [agent] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
          .limit(1);
        resolvedAgentId = agent?.id;
      }
      if (!resolvedAgentId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Orchestrator agent not found",
        });
      }
      const channel = await resolveAiChannelByFamily({
        userId: input.userId,
        workspaceId: input.workspaceId,
        family: "agent",
        agentId: resolvedAgentId,
      });
      return { channel };
    }),

  /**
   * Trigger an AI response in a channel with a skill prompt override.
   * Requires: hub-protocol.write scope
   *
   * Inserts a system message with the skill prompt into the channel, then
   * emits a chat event that causes the IS to generate an AI response.
   * Used by skill triggers to fire a skill into a user's personal channel
   * or a newly created thread.
   */
  triggerAI: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        channelId: z.string().uuid(),
        userId: z.string(),
        workspaceId: z.string().uuid(),
        /** The skill prompt injected as the user turn that drives the AI response */
        systemPromptOverride: z.string().min(1),
        /** Optional skill ID for attribution / metadata */
        skillId: z.string().uuid().optional(),
        /** Optional entity ID that the skill is acting on */
        entityId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input }) => {
      // Verify channel exists
      const channel = await db.query.channels.findFirst({
        where: eq(channels.id, input.channelId),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      // Insert a system-role message carrying the skill prompt.
      // The IS will pick this up as the trigger message and respond.
      const messageId = randomUUID();
      const content = input.systemPromptOverride;
      const hash = createHash("sha256")
        .update(`${messageId}${content}`)
        .digest("hex");

      await db.insert(messages).values({
        id: messageId,
        channelId: input.channelId,
        role: MessageRole.SYSTEM,
        authorType: MessageAuthorType.AI_AGENT,
        content,
        userId: input.userId,
        previousHash: "",
        hash,
        metadata: {
          type: "skill_trigger",
          systemPromptOverride: input.systemPromptOverride,
          skillId: input.skillId,
          entityId: input.entityId,
        } as Record<
          string,
          unknown
        > as (typeof messages.$inferInsert)["metadata"],
      });

      await db
        .update(channels)
        .set({ updatedAt: new Date() })
        .where(eq(channels.id, input.channelId));

      // Emit chat event — causes IS to generate an AI response in this channel
      emitChatEvent({
        event: EventNames.CHAT_MESSAGE,
        data: {
          threadId: input.channelId,
          message: {
            id: messageId,
            threadId: input.channelId,
            role: MessageRole.SYSTEM,
            content,
            userId: input.userId,
            timestamp: new Date(),
            previousHash: "",
            hash,
            metadata: {
              type: "skill_trigger",
              skillId: input.skillId,
              entityId: input.entityId,
            },
          },
          userId: input.userId,
          triggerAI: true,
        },
        workspaceId: input.workspaceId,
        userId: input.userId,
      });

      return {
        status: "triggered" as const,
        messageId,
        channelId: input.channelId,
      };
    }),

  /**
   * List A2AI channels for a workspace.
   * Requires: hub-protocol.read scope
   *
   * Used by OpenClaw to discover channels it participates in or is invited to.
   */
  listA2AIChannels: scopedProcedure(["hub-protocol.read"])
    .input(
      z.object({
        workspaceId: z.string().uuid(),
        /** Optional: filter to channels where this agent is a participant */
        agentUserId: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      })
    )
    .query(async ({ input }) => {
      const rows = await db.query.channels.findMany({
        where: and(
          eq(channels.workspaceId, input.workspaceId),
          eq(channels.channelType, ChannelType.AGENT_COLLAB)
        ),
        orderBy: (t, { desc }) => desc(t.updatedAt),
        limit: input.limit,
      });

      // If agentUserId filter specified, include channels where:
      //   - visibility is "open" (discoverable), or
      //   - agentUserId is in metadata.participants
      const filtered = input.agentUserId
        ? rows.filter((ch) => {
            const meta = (ch.metadata ?? {}) as {
              visibility?: string;
              participants?: string[];
            };
            return (
              meta.visibility === "open" ||
              (meta.participants ?? []).includes(input.agentUserId!)
            );
          })
        : rows;

      return {
        channels: filtered.map((ch) => {
          const meta = (ch.metadata ?? {}) as {
            topic?: string;
            visibility?: string;
            participants?: string[];
            a2aiStatus?: string;
          };
          return {
            id: ch.id,
            title: ch.title,
            topic: meta.topic,
            visibility: meta.visibility ?? "closed",
            participants: meta.participants ?? [],
            status: meta.a2aiStatus ?? "active",
            updatedAt: ch.updatedAt.toISOString(),
          };
        }),
      };
    }),
});
