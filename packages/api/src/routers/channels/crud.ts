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
import { protectedProcedure, workspaceProcedure } from "../../trpc.js";
import { AccessContext } from "../../access/index.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";

import { channelVisibilityWhere } from "../../utils/channel-visibility.js";

import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  or,
  inArray,
  isNull,
  setChannelBranchPurpose,
  ChannelFirewallImmutableError,
} from "@synap/database";
import {
  channels,
  channelMembers,
  ChannelMemberKind,
  ChannelMemberRole,
  AiReactionMode,
  messages,
  channelContextItems,
  ChannelType,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
  users,
  workspaceMembers,
  focusSessions,
  agents,
} from "@synap/database/schema";

import { resolveOrCreateChannel } from "../../utils/resolve-or-create-channel.js";
import {
  ensureAgentInstanceThread,
  getAgentIdBySlug,
  startNewPersonalConversation,
  closePersonalConversation,
  reopenPersonalConversation,
  listPersonalConversationHistory,
} from "../../utils/personal-channel.js";
import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";

import { createLinks } from "../../services/links/links-service.js";

import { EventNames } from "@synap-core/types/events";
import { MessageLinksRepository } from "@synap/database";
import {
  MessageLinkTargetType,
  MessageLinkRelationshipType,
} from "@synap-core/types";
import { randomUUID } from "crypto";
import { computeMessageHash } from "@synap/database";
import { emitMessageEvent } from "@synap/database";

import { AgentRepository } from "@synap/database";

import {
  CONTEXT_OBJECT_TYPE_VALUES,
  CHANNEL_TYPE_VALUES,
  resolveAgentId,
  listChannelsWithFlags,
  assertChannelMembershipAccess,
  buildBranchTree,
  resolveContextItemNames,
} from "./helpers.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "channels" });

export const crudProcedures = {
  /**
   * Resolve or create a channel using the canonical V2 channelType vocabulary.
   *
   * Speaks the spec's model directly — channelType + optional contextObjectType
   * + scope — so there's no translation layer between the wire and the database.
   *
   * Spec: synap-team-docs/content/team/platform/channel-system.mdx
   */
  resolveOrCreateChannel: protectedProcedure
    .input(
      z.object({
        // resolveOrCreateChannel util still owns personal/thread/sub_thread/feed
        // (external/agent_collab reject bootstrap). RUN is created via
        // openProcessChannel / ensureRunChannel; GROUP via createGroupChannel.
        channelType: z.enum([
          ChannelType.PERSONAL,
          ChannelType.THREAD,
          ChannelType.SUB_THREAD,
          ChannelType.FEED,
          ChannelType.EXTERNAL,
          ChannelType.AGENT_COLLAB,
        ]),
        workspaceId: z.string().uuid().optional(),
        contextObjectType: z
          .enum([
            "workspace",
            "entity",
            "document",
            "view",
            "project",
            "task",
            "user",
            "external",
            "proposal",
          ])
          .optional(),
        contextObjectId: z.string().uuid().optional(),
        projectId: z.string().uuid().optional(),
        parentChannelId: z.string().uuid().optional(),
        branchPurpose: z.string().max(500).optional(),
        /** Agent UUID — preferred for PERSONAL channels when known. */
        agentId: z.string().uuid().optional(),
        /** Agent slug — fallback identifier, resolves with orchestrator default. */
        agentSlug: z.string().max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const channel = await resolveOrCreateChannel({
        userId: ctx.userId,
        workspaceId: input.workspaceId ?? ctx.workspaceId ?? undefined,
        channelType: input.channelType,
        contextObjectType: input.contextObjectType,
        contextObjectId: input.contextObjectId,
        projectId: input.projectId,
        parentChannelId: input.parentChannelId,
        branchPurpose: input.branchPurpose,
        agentId: input.agentId,
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
        branchedFromMessageId: z.string().uuid().optional(),
        branchPurpose: z.string().optional(),
        /** Project lens (cross-cutting) to tag this channel with, if any. */
        projectId: z.string().uuid().optional(),
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
            projectId: input.projectId ?? null,
            parentChannelId: input.parentChannelId,
            branchedFromMessageId: input.branchedFromMessageId ?? null,
            branchPurpose: input.branchPurpose,
            agentConfig: input.agentConfig,
            channelType: ChannelType.SUB_THREAD,
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
          projectId: input.projectId ?? null,
          channelType: ChannelType.THREAD,
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
          a2aiStatus: "active",
        },
      });

      // channel_members is the source of truth for A2AI membership too (unified
      // with GROUP channels) — the per-member capability flags here govern A2AI
      // agent writes via checkPermissionOrPropose. Creator = human owner; each
      // declared participant = ai_agent member with default capability flags.
      const a2aiParticipantIds = Array.from(
        new Set((input.participants ?? []).filter((id) => id !== ctx.userId))
      );
      await db
        .insert(channelMembers)
        .values([
          {
            channelId,
            memberId: ctx.userId,
            memberKind: ChannelMemberKind.HUMAN,
            role: ChannelMemberRole.OWNER,
            addedBy: ctx.userId,
          },
          ...a2aiParticipantIds.map((id) => ({
            channelId,
            memberId: id,
            memberKind: ChannelMemberKind.AI_AGENT,
            role: ChannelMemberRole.MEMBER,
            addedBy: ctx.userId,
          })),
        ])
        .onConflictDoNothing({
          target: [channelMembers.channelId, channelMembers.memberId],
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
   * Create a room for a focus session and link it: an AGENT_COLLAB channel,
   * `focus_sessions.channelId` set, plus `channel|participant --member_of-->
   * session` graph edges so the session's room + roster live in the links graph.
   * Backs the session room's "Start a room" affordance (participants lane).
   * No-op-safe: if the session already has a channel, returns it.
   */
  createAndLinkToSession: workspaceProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
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

      // Load by id, then gate on the loaded row: the session must belong to the
      // caller's workspace (member via workspaceProcedure) OR be the caller's own
      // personal session. Without this floor, any sessionId leaked session.goal
      // and bound an AGENT_COLLAB channel onto another user's session. NOT_FOUND
      // (not FORBIDDEN) so the id is not an existence oracle.
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, input.sessionId),
      });
      if (
        !session ||
        (session.workspaceId !== workspaceId && session.userId !== ctx.userId)
      ) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      // Idempotent: a session already has at most one room.
      if (session.channelId) {
        return { channelId: session.channelId, status: "exists" as const };
      }

      const channelId = randomUUID();
      await db.insert(channels).values({
        id: channelId,
        userId: ctx.userId,
        workspaceId,
        channelType: ChannelType.AGENT_COLLAB,
        status: ChannelStatus.ACTIVE,
        title: input.title ?? `Session: ${session.goal.slice(0, 64)}`,
        metadata: { sessionId: session.id, a2aiStatus: "active" },
      });

      const agentParticipantIds = Array.from(
        new Set(
          (input.participants ?? session.agentIds ?? []).filter(
            (id) => id !== ctx.userId
          )
        )
      );
      await db
        .insert(channelMembers)
        .values([
          {
            channelId,
            memberId: ctx.userId,
            memberKind: ChannelMemberKind.HUMAN,
            role: ChannelMemberRole.OWNER,
            addedBy: ctx.userId,
          },
          ...agentParticipantIds.map((id) => ({
            channelId,
            memberId: id,
            memberKind: ChannelMemberKind.AI_AGENT,
            role: ChannelMemberRole.MEMBER,
            addedBy: ctx.userId,
          })),
        ])
        .onConflictDoNothing({
          target: [channelMembers.channelId, channelMembers.memberId],
        });

      // Link the channel to the session, both as the FK (messaging) and as graph edges.
      await db
        .update(focusSessions)
        .set({ channelId, updatedAt: new Date() })
        .where(eq(focusSessions.id, session.id));

      await createLinks([
        {
          workspaceId,
          fromType: "channel",
          fromId: channelId,
          toType: "session",
          toId: session.id,
          linkType: "member_of",
          metadata: {},
        },
        ...agentParticipantIds.map((id) => ({
          workspaceId,
          fromType: "participant" as const,
          fromId: id,
          toType: "session" as const,
          toId: session.id,
          linkType: "member_of" as const,
          metadata: { memberKind: "ai_agent" },
        })),
      ]);

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
   * Create a GROUP channel: a multi-human + multi-AI conversation. Humans can
   * write; AI agents respond when @mentioned. `participants` is a mixed list of
   * human user IDs and AI agent user IDs. Any workspace member can create one.
   */
  createGroupChannel: workspaceProcedure
    .input(
      z.object({
        name: z.string().min(1).max(255),
        /** Human user IDs + AI agent user IDs that belong to this group. */
        participants: z.array(z.string().uuid()).optional(),
        /** Project lens (cross-cutting) to tag this group room with, if any. */
        projectId: z.string().uuid().optional(),
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

      // Validate each participant id belongs to this workspace, and resolve its
      // kind (human vs ai_agent) from users.userType. A participant is valid iff
      // it is a member of THIS workspace. The creator is added separately as
      // owner, so dedupe it out of the participant list first.
      const participantIds = Array.from(
        new Set((input.participants ?? []).filter((id) => id !== ctx.userId))
      );

      const memberKindById = new Map<string, ChannelMemberKind>();
      if (participantIds.length > 0) {
        const validRows = await db
          .select({ id: users.id, userType: users.userType })
          .from(users)
          .innerJoin(
            workspaceMembers,
            and(
              eq(workspaceMembers.userId, users.id),
              eq(workspaceMembers.workspaceId, workspaceId)
            )
          )
          .where(inArray(users.id, participantIds));

        for (const row of validRows) {
          memberKindById.set(
            row.id,
            row.userType === "agent"
              ? ChannelMemberKind.AI_AGENT
              : ChannelMemberKind.HUMAN
          );
        }

        const unknown = participantIds.filter((id) => !memberKindById.has(id));
        if (unknown.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Participant(s) not in this workspace: ${unknown.join(", ")}`,
          });
        }
      }

      const channelId = randomUUID();
      await db.insert(channels).values({
        id: channelId,
        userId: ctx.userId,
        workspaceId,
        projectId: input.projectId ?? null,
        channelType: ChannelType.GROUP,
        status: ChannelStatus.ACTIVE,
        title: input.name.slice(0, 255),
      });

      // channel_members is the source of truth for group membership. Creator is
      // owner; validated participants are members.
      await db.insert(channelMembers).values([
        {
          channelId,
          memberId: ctx.userId,
          memberKind: ChannelMemberKind.HUMAN,
          role: ChannelMemberRole.OWNER,
          addedBy: ctx.userId,
        },
        ...participantIds.map((id) => ({
          channelId,
          memberId: id,
          memberKind: memberKindById.get(id)!,
          role: ChannelMemberRole.MEMBER,
          addedBy: ctx.userId,
        })),
      ]);

      emitChatEvent({
        event: "channel:created",
        data: {
          channelId,
          userId: ctx.userId,
          channelType: ChannelType.GROUP,
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
      const userMessageHash = computeMessageHash(userMessageId, input.content);

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

      // Keystone fact write: user-authored doc comment is a new conversational
      // message — guarded by reaching here only after the insert above. A
      // document is not an entity, so no `entityId` is passed (honest
      // absence over a forced mismatch).
      await emitMessageEvent({
        type: "message.sent",
        userId: ctx.userId,
        channelId,
        messageId: userMessageId,
        workspaceId,
        data: { origin: "comment", documentId: input.documentId },
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
      const userMessageHash = computeMessageHash(userMessageId, input.content);

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

      // Keystone fact write: user-authored entity comment is a new
      // conversational message — guarded by reaching here only after the
      // insert above. The entity IS in scope here, so `entityId` is honest.
      await emitMessageEvent({
        type: "message.sent",
        userId: ctx.userId,
        channelId,
        messageId: userMessageId,
        workspaceId,
        entityId: input.entityId,
        data: { origin: "comment" },
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
   * List channels (optionally filtered by workspace)
   */
  listChannels: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
        /** Project lens (cross-cutting): filter channels tagged to this project. */
        projectId: z.string().uuid().optional(),
        channelType: z.enum(CHANNEL_TYPE_VALUES).optional(),
        limit: z.number().min(1).max(100).default(20),
        contextObjectId: z.string().uuid().optional(),
        contextObjectType: z.enum(CONTEXT_OBJECT_TYPE_VALUES).optional(),
        assignedAgentId: z.string().uuid().optional(),
        /** Agent INSTANCE (agent-user) id — channels this agent participates in. */
        agentUserId: z.string().uuid().optional(),
        /** Include archived/merged channels. Default false — see helper doc. */
        includeArchived: z.boolean().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const channelsWithFlags = await listChannelsWithFlags({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        channelType: input.channelType,
        contextObjectId: input.contextObjectId,
        contextObjectType: input.contextObjectType,
        assignedAgentId: input.assignedAgentId,
        agentMemberId: input.agentUserId,
        includeArchived: input.includeArchived,
        limit: input.limit,
      });

      if (channelsWithFlags.length === 0) {
        return { channels: [] };
      }

      return { channels: channelsWithFlags };
    }),

  /**
   * Start a fresh private Personal conversation. The current active template
   * conversation for this user and agent is archived first and remains in
   * History; generic PERSONAL resolve-or-create semantics are unchanged.
   */
  /**
   * Open (ensure + seed) a RUN channel for live process narration.
   * Capture follow-up, import, automation UI, etc. call this then open
   * Companion on the returned channelId. System seed lines do not trigger AI;
   * the user's next free-text message flips into an agent turn.
   */
  openProcessChannel: protectedProcedure
    .input(
      z.object({
        flowType: z
          .string()
          .min(1)
          .max(64)
          .regex(
            /^[a-z][a-z0-9_-]*$/i,
            "flowType must be a short slug (e.g. capture, import)"
          ),
        flowId: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
        title: z.string().max(200).optional(),
        seedMessages: z
          .array(
            z.object({
              role: z.enum(["user", "system", "assistant"]),
              content: z.string().min(1).max(8000),
              metadata: z.record(z.string(), z.unknown()).optional(),
              idempotencyKey: z.string().max(200).optional(),
            })
          )
          .max(20)
          .optional(),
        channelMetadata: z.record(z.string(), z.unknown()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
      if (workspaceId) {
        await assertWorkspaceWrite(db, ctx.userId, {
          workspaceId,
        });
      }
      const { openProcessChannel } =
        await import("../../services/messaging/open-process-channel.js");
      const result = await openProcessChannel({
        userId: ctx.userId,
        flowType: input.flowType,
        flowId: input.flowId,
        workspaceId,
        title: input.title,
        seedMessages: input.seedMessages,
        channelMetadata: input.channelMetadata,
      });
      return {
        channelId: result.channel.id,
        channel: result.channel,
        created: result.created,
        messageIds: result.messageIds,
      };
    }),

  /**
   * Post a single narrative line into an existing RUN (or other) channel.
   * System role = infrastructure talking; does not trigger an agent turn.
   * User role + triggerAI = flip into agent dialogue.
   */
  narrate: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        content: z.string().min(1).max(8000),
        role: z.enum(["system", "assistant", "user"]).default("system"),
        metadata: z.record(z.string(), z.unknown()).optional(),
        /** Only meaningful for role=user — kick off an agent turn. */
        triggerAI: z.boolean().optional(),
        idempotencyKey: z.string().max(200).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Ownership: channel must belong to the caller (run channels are user-owned).
      const [channel] = await db
        .select({
          id: channels.id,
          userId: channels.userId,
          channelType: channels.channelType,
        })
        .from(channels)
        .where(eq(channels.id, input.channelId))
        .limit(1);
      if (!channel || channel.userId !== ctx.userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }
      // Narrate is the process-channel door — don't inject system lines into
      // personal/group/etc. by accident.
      if (channel.channelType !== ChannelType.RUN) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "narrate is only valid on run channels",
        });
      }

      if (input.role === "user" && input.triggerAI) {
        const { postChannelMessage } =
          await import("../../services/messaging/post-message.js");
        return postChannelMessage({
          channelId: input.channelId,
          content: input.content,
          role: "user",
          triggerAI: true,
          userId: ctx.userId,
          idempotencyKey: input.idempotencyKey,
        });
      }

      // System / assistant / user-without-AI narrative insert.
      const { deterministicUuidFromKey } =
        await import("../../utils/write-door-idempotency.js");
      const msgId = input.idempotencyKey
        ? deterministicUuidFromKey(
            `narrate:${input.channelId}:${input.idempotencyKey}`
          )
        : randomUUID();
      const roleEnum =
        input.role === "user"
          ? MessageRole.USER
          : input.role === "system"
            ? MessageRole.SYSTEM
            : MessageRole.ASSISTANT;
      const authorType =
        input.role === "user"
          ? MessageAuthorType.HUMAN
          : input.role === "system"
            ? MessageAuthorType.BOT
            : MessageAuthorType.AI_AGENT;
      const hash = computeMessageHash(msgId, input.content);
      const inserted = await db
        .insert(messages)
        .values({
          id: msgId,
          channelId: input.channelId,
          role: roleEnum,
          authorType,
          messageCategory:
            input.role === "system"
              ? MessageCategory.SYSTEM_NOTIFICATION
              : MessageCategory.CHAT,
          content: input.content,
          userId: ctx.userId,
          hash,
          previousHash: "",
          metadata: input.metadata ?? null,
        })
        .onConflictDoNothing({ target: messages.id })
        .returning({ id: messages.id });

      if (inserted.length > 0) {
        emitChatEvent({
          event: EventNames.CHAT_MESSAGE,
          data: {
            threadId: input.channelId,
            message: {
              id: msgId,
              threadId: input.channelId,
              role: roleEnum,
              authorType,
              content: input.content,
              userId: ctx.userId,
              timestamp: new Date(),
              previousHash: "",
              hash,
              metadata: input.metadata,
            },
            userId: ctx.userId,
          },
          userId: ctx.userId,
          channelId: input.channelId,
        });
      }

      return {
        success: true as const,
        messageId: msgId,
        channelId: input.channelId,
        ackState:
          inserted.length > 0
            ? ("applied" as const)
            : ("duplicate-ignored" as const),
      };
    }),

  startNewPersonalConversation: protectedProcedure
    .input(z.object({ agentId: z.string().uuid().optional() }))
    .mutation(async ({ input, ctx }) => {
      const agentId = await resolveAgentId(input.agentId);
      const result = await startNewPersonalConversation(ctx.userId, agentId);

      for (const archivedChannelId of result.archivedChannelIds) {
        emitChatEvent({
          event: "channel:archived",
          data: { channelId: archivedChannelId, userId: ctx.userId },
          userId: ctx.userId,
          channelId: archivedChannelId,
        });
      }
      emitChatEvent({
        event: "channel:created",
        data: { channelId: result.channel.id, userId: ctx.userId },
        userId: ctx.userId,
        channelId: result.channel.id,
      });

      return result;
    }),

  /**
   * List only archived template PERSONAL conversations for History. Agent
   * instance DMs and merged duplicate rows are intentionally excluded.
   */
  listPersonalConversationHistory: protectedProcedure
    .input(
      z.object({
        agentId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const agentId = await resolveAgentId(input.agentId);
      const items = await listPersonalConversationHistory(
        ctx.userId,
        agentId,
        input.limit + 1,
        input.offset
      );
      const hasMore = items.length > input.limit;

      return {
        items: hasMore ? items.slice(0, input.limit) : items,
        pagination: {
          hasMore,
          limit: input.limit,
          offset: input.offset,
        },
      };
    }),

  /**
   * Reopen a conversation selected from History. It is restored as the only
   * active template PERSONAL conversation for its original assigned agent.
   */
  reopenPersonalConversation: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const result = await reopenPersonalConversation(
        ctx.userId,
        input.channelId
      );
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Archived personal conversation not found",
        });
      }

      for (const archivedChannelId of result.archivedChannelIds) {
        emitChatEvent({
          event: "channel:archived",
          data: { channelId: archivedChannelId, userId: ctx.userId },
          userId: ctx.userId,
          channelId: archivedChannelId,
        });
      }
      emitChatEvent({
        event: "channel:updated",
        data: { channelId: result.channel.id, userId: ctx.userId },
        userId: ctx.userId,
        channelId: result.channel.id,
      });

      return result;
    }),

  /** Close the active template Personal conversation without deleting History. */
  closePersonalConversation: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const channel = await closePersonalConversation(
        ctx.userId,
        input.channelId
      );
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Active personal conversation not found",
        });
      }

      emitChatEvent({
        event: "channel:archived",
        data: { channelId: channel.id, userId: ctx.userId },
        userId: ctx.userId,
        channelId: channel.id,
      });

      return { channel };
    }),

  /**
   * List only thread channels.
   */
  listThreads: protectedProcedure
    .input(
      z.object({
        workspaceId: z.string().uuid().optional(),
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
      // `agentId` is the agent-USER instance id (a `users` row, userType=agent).
      // assignedAgentId is a template-only FK, so we key the thread to the INSTANCE
      // via channel_members and resolve the instance's agentType → template for the
      // IS agent class. Falls back to the legacy template path for non-instance ids.
      const instance = await db.query.users.findFirst({
        where: and(eq(users.id, input.agentId), eq(users.userType, "agent")),
        columns: { id: true, agentMetadata: true },
      });

      if (instance) {
        const agentType =
          (instance.agentMetadata as { agentType?: string } | null)
            ?.agentType ?? "orchestrator";
        const templateId =
          (await getAgentIdBySlug(agentType)) ??
          (await getAgentIdBySlug("orchestrator"));
        const channel = await ensureAgentInstanceThread(
          ctx.userId,
          instance.id,
          templateId
        );
        return { channel };
      }

      // Backward-compat: treat a non-instance id as a template/agents id.
      const channel = await resolveOrCreateChannel({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        channelType: ChannelType.PERSONAL,
        agentId: input.agentId,
      });
      return { channel };
    }),

  /**
   * Get or create a personal AI thread for an agent identified by type/slug.
   * Auto-bootstraps a stub agent record when none exists — IS sync will enrich it later.
   * Use this instead of getOrCreateAgentThread when you have an agentType string (e.g. from
   * the IS manifest) rather than a DB UUID.
   */
  getOrCreateAgentThreadByType: workspaceProcedure
    .input(z.object({ agentType: z.string().min(1).max(100) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.userId!;

      // Find existing stub (intelligenceServiceId IS NULL = Synap IS placeholder).
      // NULLs are non-equal in Postgres unique indexes so we check explicitly.
      let agentRow = await db.query.agents.findFirst({
        where: and(
          eq(agents.slug, input.agentType),
          eq(agents.active, true),
          isNull(agents.intelligenceServiceId)
        ),
        columns: { id: true },
      });

      if (!agentRow) {
        const [created] = await db
          .insert(agents)
          .values({
            slug: input.agentType,
            name: input.agentType, // IS sync will overwrite with manifest display name
            ownerType: "synap",
            active: true,
            capabilities: [],
          })
          .returning({ id: agents.id });
        agentRow = created;
      }

      if (!agentRow) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to resolve agent stub",
        });
      }

      const channel = await resolveOrCreateChannel({
        userId,
        channelType: ChannelType.PERSONAL,
        agentId: agentRow.id,
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
      const channel = await resolveOrCreateChannel({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        channelType: ChannelType.THREAD,
        contextObjectType: "workspace",
        contextObjectId: ctx.workspaceId,
      });
      return { channel };
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
      // Canonical channel visibility — workspace members can access details
      // of shared channels (GROUP/AGENT_COLLAB/EXTERNAL) they don't own.
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, input.channelId),
          channelVisibilityWhere(ctx.userId)
        ),
      });

      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found or access denied",
        });
      }

      // Get context items (entities + documents) if requested
      let contextItems: (typeof channelContextItems.$inferSelect & {
        objectName: string | null;
      })[] = [];

      if (input.includeContext) {
        const rows = await db.query.channelContextItems.findMany({
          where: eq(channelContextItems.channelId, input.channelId),
        });
        const names = await resolveContextItemNames(
          rows,
          AccessContext.from(ctx)
        );
        contextItems = rows.map((row) => ({
          ...row,
          objectName: names.get(row.objectId) ?? null,
        }));
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
        /** Per-channel "how AI teammates react" control for multiplayer rooms. */
        aiReactionMode: z
          .enum([
            AiReactionMode.ONLY_MENTIONED,
            AiReactionMode.WHEN_CONFIDENT,
            AiReactionMode.OFF,
          ])
          .optional(),
        /** Bind an agent INSTANCE (agent-user id) to this channel as an ai_agent member. */
        addAgentMemberId: z.string().uuid().optional(),
        /** Unbind an agent INSTANCE from this channel. */
        removeAgentMemberId: z.string().uuid().optional(),
        /** Bind this channel to a context object (e.g. a client entity). Set all
         *  three (or the pair) together — the governed home for "point this
         *  existing channel at this object", used by the channel.bind builtin verb
         *  for the inbound-first case where the channel already exists. */
        contextObjectType: z.enum(CONTEXT_OBJECT_TYPE_VALUES).optional(),
        contextObjectId: z.string().uuid().optional(),
        /** Firewall role label ("client-comms" / "team") — see the delivery firewall. */
        branchPurpose: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Membership access, not owner-only: the sidebar lists channels by
      // membership/visibility (channelVisibilityWhere), so a member could see a
      // shared channel yet 404 on rename — the same ownership-vs-membership gap
      // archiveChannel had. Same door its sibling mutations already use.
      const channel = await assertChannelMembershipAccess(
        input.channelId,
        ctx.userId
      );

      await db
        .update(channels)
        .set({
          title: input.title,
          assignedAgentId: input.assignedAgentId,
          agentConfig: input.agentConfig,
          ...(input.mcpServerIds !== undefined && {
            mcpServerIds: input.mcpServerIds,
          }),
          ...(input.aiReactionMode !== undefined && {
            aiReactionMode: input.aiReactionMode,
          }),
          ...(input.contextObjectType !== undefined && {
            contextObjectType: input.contextObjectType,
          }),
          ...(input.contextObjectId !== undefined && {
            contextObjectId: input.contextObjectId,
          }),
          updatedAt: new Date(),
        })
        .where(eq(channels.id, input.channelId));

      // FIREWALL role via the ONE door — client-comms is immutable (the door
      // throws, the DB trigger is the floor). Written separately from the .set()
      // above so the invariant lives in exactly one place.
      if (input.branchPurpose !== undefined) {
        try {
          await setChannelBranchPurpose({
            channelId: input.channelId,
            branchPurpose: input.branchPurpose,
          });
        } catch (err) {
          if (err instanceof ChannelFirewallImmutableError) {
            throw new TRPCError({ code: "FORBIDDEN", message: err.message });
          }
          throw err;
        }
      }

      // Per-instance agent binding lives in channel_members (assignedAgentId is
      // a template-only FK and cannot reference an agent-user instance).
      //
      // Security: apply the same validation as addTeammate — verify the id
      // references an actual agent-user (userType='agent') and that it belongs
      // to the channel's workspace. This prevents a foreign-workspace agent or
      // a human user from being bound as AI_AGENT via this legacy side-effect.
      if (input.addAgentMemberId) {
        const [agentUserCheck] = await db
          .select({ id: users.id, userType: users.userType })
          .from(users)
          .where(
            and(
              eq(users.id, input.addAgentMemberId),
              eq(users.userType, "agent")
            )
          )
          .limit(1);
        if (!agentUserCheck) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "addAgentMemberId does not reference an agent user",
          });
        }
        if (channel.workspaceId) {
          const wsMembership = await db.query.workspaceMembers.findFirst({
            where: and(
              eq(workspaceMembers.workspaceId, channel.workspaceId),
              eq(workspaceMembers.userId, input.addAgentMemberId)
            ),
            columns: { id: true },
          });
          if (!wsMembership) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Teammate is not a member of this channel's workspace",
            });
          }
        }

        const already = await db.query.channelMembers.findFirst({
          where: and(
            eq(channelMembers.channelId, input.channelId),
            eq(channelMembers.memberId, input.addAgentMemberId)
          ),
          columns: { channelId: true },
        });
        if (!already) {
          await db.insert(channelMembers).values({
            channelId: input.channelId,
            memberId: input.addAgentMemberId,
            memberKind: ChannelMemberKind.AI_AGENT,
            role: ChannelMemberRole.MEMBER,
            addedBy: ctx.userId,
          });
        }
      }
      if (input.removeAgentMemberId) {
        // Only remove ai_agent members via this path — prevents accidental
        // removal of human members through the legacy teammate-binding side-effect.
        await db
          .delete(channelMembers)
          .where(
            and(
              eq(channelMembers.channelId, input.channelId),
              eq(channelMembers.memberId, input.removeAgentMemberId),
              eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
            )
          );
      }

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
   * Archive channel (soft delete)
   */
  archiveChannel: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await assertChannelMembershipAccess(
        input.channelId,
        ctx.userId
      );

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
};
