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

import { protectedProcedure } from "../../trpc.js";

import { getPodCallback } from "../../utils/pod-callback.js";
import { channelVisibilityWhere } from "../../utils/channel-visibility.js";

import { queryChannelMessages } from "../../utils/query-channel-messages.js";
import { aiRateLimitMiddleware } from "../../middleware/ai-rate-limit.js";
import {
  describeAiFailure,
  describePartialTurnFailure,
  type AiFailureDescription,
  type PartialTurnFailure,
} from "../../utils/ai-failure.js";
import { ChatTurnFailureError } from "../../utils/ai-failure-error.js";
import {
  narrowPartialFailure,
  type ISPartialFailure,
} from "@synap/intelligence-client";
import {
  resolveAgentHandle,
  extractMentionAgentType,
  extractHumanMentionHandles,
} from "../../utils/agent-handles.js";
import { NotificationService } from "../../notifications/NotificationService.js";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  and,
  drizzleSql,
  persistAssistantReply,
} from "@synap/database";
import {
  channels,
  channelMembers,
  ChannelMemberKind,
  ChannelMemberRole,
  AiReactionMode,
  messages,
  channelContextItems,
  entities as entitiesTable,
  ChannelType,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  users,
  workspaceMembers,
  workspaces,
  projects,
  sessions,
  SessionStatus,
  focusSessions,
  agents,
  RoutedSource,
} from "@synap/database/schema";
import { resolveIntelligenceServiceByAgentId } from "../../utils/intelligence-routing.js";
import {
  makeRoutedTeammateContext,
  type RoutedTeammateContext,
} from "../../utils/permission-check.js";

import { resolveOrCreateChannel } from "../../utils/resolve-or-create-channel.js";
import { emitMessageObservation } from "../../utils/emit-message-observation.js";

import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";
import { SERVER_CONVERSATION_EVENTS } from "../../realtime/socket-events.js";

import { emitTyped } from "../../utils/event-emit.js";
import { makeExcerpt } from "../../utils/excerpt.js";
import { EventNames } from "@synap-core/types/events";

import { randomUUID } from "crypto";
import { computeMessageHash } from "@synap/database";
import type { AIStep, HubResponse } from "@synap-core/types";
import type { McpServerEntry } from "./helpers.js";

import { emitSideEffects, getBoss } from "@synap/events";

import { AgentRepository } from "@synap/database";

import {
  createOrGetChatTurnWithUserMessage,
  finishChatTurn,
  getChatTurnByRequest,
  getChatTurnForUser,
} from "../../services/chat-turns/chat-turn-store.js";
import {
  activateChatTurn,
  completeActiveChatTurn,
} from "../../services/chat-turns/chat-turn-runtime.js";
import { withTurnStreamSignal } from "../../utils/channel-turn-transport.js";
import {
  channelSendMessageInputSchema,
  redactTurnContext,
  projectTurnAccessWhere,
  usesInternalSessionBoundary,
  handleCandidatesFor,
  resolveAgentId,
  getMcpServersForWorkspace,
  ensureAgentUser,
  relayToExternalChannel,
} from "./helpers.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "channels" });

/**
 * Send message to Intelligence Hub and get AI response (with streaming).
 * When threadId is omitted, the backend creates a new channel and attaches the message.
 */
export const sendMessageProcedure = protectedProcedure
  .use(aiRateLimitMiddleware)
  .input(channelSendMessageInputSchema)
  .mutation(async ({ input, ctx }) => {
    // protectedProcedure guarantees userId — narrow type for Drizzle compatibility
    const userId = ctx.userId!;
    let channelId = input.channelId;
    const content = input.content;
    const workspaceId = input.workspaceId ?? ctx.workspaceId ?? undefined;
    const projectId = input.projectId;
    const requestedAgentId: string | undefined = input.agentId;
    const turnContext = input.turnContext
      ? redactTurnContext(input.turnContext)
      : undefined;

    if (projectId) {
      const authorizedProject = await db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), projectTurnAccessWhere(userId)),
        columns: { id: true },
      });
      if (!authorizedProject) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found or inaccessible",
        });
      }
    }

    // A clientRequestId names one user intent, including Home's first turn
    // before it has a channel id. Check it before resolving/creating a
    // channel so a network retry cannot create a second room or model run.
    if (input.clientRequestId) {
      const existingTurn = await getChatTurnByRequest({
        userId,
        requestId: input.clientRequestId,
      });
      if (existingTurn) {
        const existingAssistant = await db.query.messages.findFirst({
          where: eq(messages.id, existingTurn.assistantMessageId),
          columns: { content: true },
        });
        return {
          channelId: existingTurn.channelId,
          messageId: existingTurn.assistantMessageId,
          content: existingAssistant?.content ?? "",
          entities: [],
          branchDecision: undefined,
          branchThread: undefined,
          aiSteps: [],
          createdProposals: [],
          turnId: existingTurn.id,
          userMessageId: existingTurn.userMessageId,
          assistantMessageId: existingTurn.assistantMessageId,
          reused: true,
        };
      }
    }

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
          .where(and(eq(agents.slug, "orchestrator"), eq(agents.active, true)))
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
      const resolvedChannel = await resolveOrCreateChannel({
        userId,
        workspaceId,
        channelType: input.channelType ?? ChannelType.PERSONAL,
        contextObjectType: input.contextObjectType,
        contextObjectId: input.contextObjectId,
        parentChannelId: input.parentChannelId,
        branchPurpose: input.branchPurpose,
      });
      channelId = resolvedChannel.id;
    }

    // Get channel — scoped to what the caller may see via the canonical
    // visibility predicate so workspace membership alone is not enough to
    // post in private channels (THREAD/PERSONAL) that belong to someone else.
    const channel = await db.query.channels.findFirst({
      where: and(
        eq(channels.id, channelId),
        eq(channels.status, ChannelStatus.ACTIVE),
        channelVisibilityWhere(userId)
      ),
    });

    if (!channel) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Channel not found or access denied",
      });
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
    if (usesInternalSessionBoundary(channel.channelType)) {
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

    // Look up active focus session for this channel — explicit, user-visible sessions
    // that link proposals from this run to a goal-bound context.
    // Separate from `activeSessionId` (IS memory compaction, internal).
    let activeFocusSessionId: string | undefined;
    try {
      const activeFocusSession = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.channelId, channelId),
          eq(focusSessions.status, "active")
        ),
        columns: { id: true },
        orderBy: (fs, { desc }) => [desc(fs.startedAt)],
      });
      activeFocusSessionId = activeFocusSession?.id;
    } catch {
      // Non-fatal — proposal linking degrades gracefully
    }

    // Save user message
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const userMessageHash = computeMessageHash(userMessageId, content);
    let durableTurn:
      | Awaited<ReturnType<typeof createOrGetChatTurnWithUserMessage>>["turn"]
      | undefined;
    let turnAbortController: AbortController | undefined;
    let socketTurnSeq = 0;
    const turnEnvelope = (type: string) =>
      durableTurn
        ? {
            type,
            turnId: durableTurn.id,
            channelId,
            seq: ++socketTurnSeq,
          }
        : { type };
    const userMessage = {
      id: userMessageId,
      channelId,
      role: MessageRole.USER,
      content,
      userId,
      previousHash: "",
      hash: userMessageHash,
      sessionId: activeSessionId ?? undefined,
      ephemeral: input.ephemeral ?? false,
      ...(turnContext
        ? {
            metadata: {
              turnContext,
            } as (typeof messages.$inferInsert)["metadata"],
          }
        : {}),
    };

    if (input.clientRequestId) {
      const claimed = await createOrGetChatTurnWithUserMessage({
        turn: {
          channelId,
          userId,
          requestId: input.clientRequestId,
          userMessageId,
          assistantMessageId,
        },
        userMessage,
      });
      durableTurn = claimed.turn;

      // The unique `(user, channel, request)` key is the only authority for
      // retry behaviour. A reconnect must attach to its original turn, never
      // write another user message or invoke the model a second time.
      if (!claimed.created) {
        const existingAssistant = await db.query.messages.findFirst({
          where: eq(messages.id, durableTurn.assistantMessageId),
          columns: { content: true },
        });
        return {
          channelId,
          messageId: durableTurn.assistantMessageId,
          content: existingAssistant?.content ?? "",
          entities: [],
          branchDecision: undefined,
          branchThread: undefined,
          aiSteps: [],
          createdProposals: [],
          turnId: durableTurn.id,
          userMessageId: durableTurn.userMessageId,
          assistantMessageId: durableTurn.assistantMessageId,
          reused: true,
        };
      }

      turnAbortController = activateChatTurn(durableTurn.id);
    } else {
      await db.insert(messages).values(userMessage);
    }

    // Keystone fact write: append `message.sent` to the `events` log
    // alongside the `messages` insert above, so analyzers can read the log
    // and replay over history. Reached ONLY when a NEW user-message row just
    // landed — the durable-turn dedup path above (`!claimed.created`) already
    // returned early for a reused/duplicate `clientRequestId`, so there is no
    // idempotent-conflict re-delivery case to guard here (unlike the inbound
    // `onConflictDoNothing` path). Points at the real channel (+ the bound
    // entity, when linked via `contextObjectId`) — never copies the message
    // body.
    await emitMessageObservation({
      type: "message.sent",
      userId,
      channelId,
      messageId: userMessageId,
      workspaceId: workspaceId ?? channel.workspaceId ?? undefined,
      // Only pass through when the binding is actually entity-typed —
      // `contextObjectId` can also point at a workspace/document/view (see
      // channels.contextObjectType), and `entityId` must stay honest about
      // what kind of real object it names.
      entityId:
        channel.contextObjectType === "entity"
          ? (channel.contextObjectId ?? undefined)
          : undefined,
      data: {
        authorType: MessageAuthorType.HUMAN,
      },
    });

    // Additive lifecycle event. Existing Socket.IO consumers can ignore it;
    // the canonical HTTP sender stream uses it to establish turnId exactly
    // when the triggering message becomes durable.
    emitChatEvent({
      event: EventNames.CHAT_STREAM,
      data: {
        threadId: channelId,
        ...turnEnvelope("start"),
        isComplete: false,
        triggerMessageId: userMessageId,
        userMessageId,
        turnId: durableTurn?.id,
        assistantMessageId: durableTurn?.assistantMessageId,
      },
      workspaceId: workspaceId ?? null,
      userId,
      channelId,
    });

    // Human @mention notifications — DISTINCT from agent @handles (which route
    // to an AI, above). Resolve the plain @handles that are NOT agent handles
    // against this channel's HUMAN members and notify each (excluding the
    // sender / self-mentions). Skipped for ephemeral messages: they vanish on
    // reload, so a durable notification would point at nothing.
    if (!input.ephemeral) {
      const humanHandles = extractHumanMentionHandles(content);
      if (humanHandles.length > 0) {
        try {
          const humanMembers = await db
            .select({ memberId: channelMembers.memberId, name: users.name })
            .from(channelMembers)
            .innerJoin(users, eq(users.id, channelMembers.memberId))
            .where(
              and(
                eq(channelMembers.channelId, channelId),
                eq(channelMembers.memberKind, ChannelMemberKind.HUMAN)
              )
            );

          // Resolve sender display name (for the notification title) once.
          const senderRow = humanMembers.find((m) => m.memberId === userId);
          const senderName = senderRow?.name ?? "Someone";
          const preview =
            content.length > 140 ? `${content.slice(0, 140)}…` : content;

          const notified = new Set<string>();
          for (const member of humanMembers) {
            if (member.memberId === userId) continue; // no self-mention
            if (notified.has(member.memberId)) continue;
            // A member matches a handle when a normalized form of their display
            // name equals one of the mentioned handles.
            const candidates = handleCandidatesFor(member.name);
            if (!humanHandles.some((h) => candidates.has(h))) continue;
            notified.add(member.memberId);

            await NotificationService.create({
              type: "chat.mention",
              userId: member.memberId,
              workspaceId: workspaceId ?? channel.workspaceId ?? null,
              sourceType: "system",
              sourceId: channelId,
              data: {
                sender: senderName,
                preview,
                channelId,
                messageId: userMessageId,
              },
            });
          }
        } catch (err) {
          // Non-fatal — a failed mention notification must never fail the send.
          logger.warn({ err, channelId }, "human @mention notification failed");
        }
      }
    }

    // Link attachment entities to channel context
    if (input.attachmentEntityIds?.length) {
      const attachmentMeta: Array<{
        entityId: string;
        fileName: unknown;
        mimeType: unknown;
      }> = [];

      for (const attachEntityId of input.attachmentEntityIds) {
        // Verify entity exists and is a `file` belonging to this user.
        const entity = await db.query.entities.findFirst({
          where: and(
            eq(entitiesTable.id, attachEntityId),
            eq(entitiesTable.type, "file")
          ),
          columns: { id: true, title: true, properties: true },
        });
        if (!entity) continue;

        const props = entity.properties as Record<string, unknown>;
        attachmentMeta.push({
          entityId: attachEntityId,
          // Canonical `file` entities carry the filename as the entity title;
          // fall back to the legacy properties.fileName for older rows.
          fileName: props.fileName ?? entity.title,
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
            workspaceId: channel.workspaceId,
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

    // Resolve the ACTING agent instance for proposal attribution.
    //
    // Source of truth = the channel's bound agent instance (the ai_agent
    // member). Per-instance threads bind the specific agent-user the human is
    // chatting with, so its proposals are credited to THAT named instance —
    // not the user's pod-wide default. This is what makes "this agent did X"
    // true and the per-agent dashboard accurate.
    //
    // Fallback (legacy/unbound personal threads, group channels) → the user's
    // pod-wide personal agent, preserving prior behaviour.
    let agentUserId: string | undefined;
    if (channel.channelType === ChannelType.PERSONAL) {
      const [boundAgent] = await db
        .select({ memberId: channelMembers.memberId })
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.channelId, channelId),
            eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
          )
        )
        .limit(1);
      agentUserId = boundAgent?.memberId;
    }
    if (!agentUserId && workspaceId) {
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
    const effectiveAgentRef = channel.assignedAgentId ?? channel.senderAgentId;
    const channelKind: "pm" | "group" =
      channel.channelType === ChannelType.PERSONAL ||
      (channel.channelType === ChannelType.SUB_THREAD && !channel.workspaceId)
        ? "pm"
        : "group";
    // ── Single-responder AI gate (THREAD / PERSONAL / EXTERNAL — unchanged) ─
    // For these channel types the prior single-agent behaviour is preserved.
    // GROUP and AGENT_COLLAB are handled by the routing engine below.
    const isAiChannel =
      channel.channelType === ChannelType.AGENT_COLLAB ||
      (channel.channelType === ChannelType.PERSONAL && !!effectiveAgentRef) ||
      (channel.channelType === ChannelType.THREAD && !!effectiveAgentRef) ||
      (channel.channelType === ChannelType.EXTERNAL && !!effectiveAgentRef) ||
      // RUN = live process narration; free-text flips to agent turn when an
      // agent is assigned (ensureRunChannel sets orchestrator by default).
      (channel.channelType === ChannelType.RUN && !!effectiveAgentRef) ||
      // GROUP handled by the routing engine (routingDecision) below;
      // keep the old mention-gate here so isAiChannel stays meaningful for
      // the fallthrough path but routing engine overrides for GROUP.
      (channel.channelType === ChannelType.GROUP && !!mentionedAgentType);

    // ── ROUTING ENGINE (GROUP / AGENT_COLLAB multiplayer rooms) ─────────────
    //
    // Restraint is the default: the correct, common outcome is SILENCE.
    //
    // Decision matrix:
    //   aiReactionMode=off            → no AI, always.
    //   explicit @mention of a channel AI_AGENT member → that teammate answers
    //                                    (routedSource='mention').
    //   aiReactionMode=only_mentioned → only @mention triggers; else silence.
    //   aiReactionMode=when_confident → ask the IS cheap router; default null.
    //
    // For non-GROUP/AGENT_COLLAB channels: null (skip routing engine, use
    // the single-responder isAiChannel gate above unchanged).

    let routingDecision: RoutedTeammateContext | null = null;
    const isMultiplayerRoom =
      channel.channelType === ChannelType.GROUP ||
      channel.channelType === ChannelType.AGENT_COLLAB;

    if (isMultiplayerRoom) {
      const reactionMode =
        (channel.aiReactionMode as AiReactionMode) ??
        AiReactionMode.WHEN_CONFIDENT;

      // Hard off — never route to any teammate.
      if (reactionMode !== AiReactionMode.OFF) {
        // 1. Explicit @mention resolution — highest priority.
        //    Validate the mentioned handle resolves to a real AI_AGENT channel member.
        if (mentionedAgentType) {
          const mentionedMember = await db
            .select({
              memberId: channelMembers.memberId,
              memberKind: channelMembers.memberKind,
            })
            .from(channelMembers)
            .innerJoin(users, eq(users.id, channelMembers.memberId))
            .where(
              and(
                eq(channelMembers.channelId, channelId),
                eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT),
                eq(users.agentType, mentionedAgentType)
              )
            )
            .limit(1)
            .then((rows) => rows[0] ?? null);

          if (mentionedMember) {
            routingDecision = makeRoutedTeammateContext(
              mentionedMember.memberId,
              "mention"
            );
          }
          // If mention doesn't resolve to a channel member → silence (no fallthrough).
        }

        // 2. when_confident: ask the IS cheap router — only if no mention resolved.
        if (
          !routingDecision &&
          reactionMode === AiReactionMode.WHEN_CONFIDENT
        ) {
          try {
            // Fetch AI_AGENT members with their identity for the router payload.
            const aiMembers = await db
              .select({
                memberId: channelMembers.memberId,
                name: users.name,
                agentType: users.agentType,
              })
              .from(channelMembers)
              .innerJoin(users, eq(users.id, channelMembers.memberId))
              .where(
                and(
                  eq(channelMembers.channelId, channelId),
                  eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
                )
              );

            if (aiMembers.length > 0) {
              // Fetch recent context (last 6 messages — cheap, bounded) through
              // the one door: excludes ephemeral recaps AND soft-deleted messages
              // so neither influences teammate routing (sender is pre-authorized,
              // so no userId gate here).
              const recentMessages = (
                await queryChannelMessages<{ role: string; content: string }>(
                  db,
                  {
                    channelId,
                    order: "desc",
                    limit: 6,
                    columns: { role: true, content: true },
                  }
                )
              ).reverse();

              const routeResult = await resolvedService.client.routeTeammate({
                channelId,
                message: content,
                recentContext: recentMessages,
                members: aiMembers.map((m) => ({
                  id: m.memberId,
                  name: m.name ?? m.agentType ?? m.memberId,
                  expertise: m.agentType ?? undefined,
                })),
              });

              if (routeResult?.teammateId) {
                // Validate the returned id is actually a channel AI_AGENT member
                // (the IS router must not be able to route to an arbitrary user id).
                const isValidMember = aiMembers.some(
                  (m) => m.memberId === routeResult.teammateId
                );
                if (isValidMember) {
                  routingDecision = makeRoutedTeammateContext(
                    routeResult.teammateId,
                    "orchestrator"
                  );
                }
              }
              // routeResult.teammateId===null → silence (restraint default).
            }
          } catch (routeErr) {
            // IS router failure → silence, never crash the message send.
            logger.warn(
              { err: routeErr, channelId },
              "IS cheap router failed — defaulting to silence"
            );
          }
        }
        // only_mentioned + no mention match → routingDecision stays null → silence.
      }
    }

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

    // For multiplayer rooms, the routing engine determines AI activity.
    // For single-responder channels, fall through to the existing isAiChannel gate.
    if (isMultiplayerRoom && !routingDecision) {
      // Routing engine decided: silence.
      return { messageId: userMessageId, channelId };
    }

    if (!isMultiplayerRoom && !isAiChannel) {
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
    const emittedProposalIds = new Set<string>();
    let hubResponse: Partial<HubResponse> = { content: "" };
    /**
     * A COMMITTED PARTIAL turn: the provider died mid-stream, the IS committed
     * the text produced so far and ended the stream NORMALLY (no `error`
     * frame). `fullContent` is real but TRUNCATED, so every terminal signal on
     * this path — the SSE `complete` frame and the persisted assistant row —
     * would otherwise report a complete success. This is the only thing that
     * distinguishes the two.
     */
    let partialFailure: ISPartialFailure | null = null;

    // Effective agent type: @mention override → assignedAgentId (or legacy senderAgentId) → default
    let effectiveAgentType = "meta";
    if (mentionedAgentType) {
      effectiveAgentType = mentionedAgentType;
    } else if (effectiveAgentRef) {
      const agentRepo = new AgentRepository(db);
      const agent = await agentRepo.getById(effectiveAgentRef);
      effectiveAgentType = agent?.slug ?? "meta";
    }

    // ── Routing dispatch wiring ───────────────────────────────────────────────
    // For multiplayer rooms with a routing decision:
    //   1. Override agentUserId with the routed teammate (server-resolved —
    //      never from request body). Hub-protocol tool call handlers will
    //      call resolveChannelCapabilities(channelId, agentUserId) themselves
    //      to apply the per-channel capability grant.
    //   2. Resolve the teammate's agentType for IS dispatch.
    //   3. Broadcast presence so the UI can show the typing indicator.
    if (routingDecision) {
      // Override agentUserId with the routed teammate (server-resolved — not
      // from request body).
      agentUserId = routingDecision.teammateId;

      // Resolve the routed teammate's agentType for effectiveAgentType override.
      try {
        const [routedUser] = await db
          .select({ agentType: users.agentType })
          .from(users)
          .where(eq(users.id, routingDecision.teammateId))
          .limit(1);
        if (routedUser?.agentType) {
          effectiveAgentType = routedUser.agentType;
        }
      } catch {
        // Non-critical — use existing effectiveAgentType
      }

      // Step 4 — Presence: broadcast "teammate X is answering" so the UI can
      // show the typing indicator. Fire-and-forget; never blocks the response.
      emitChatEvent({
        event: SERVER_CONVERSATION_EVENTS.TEAMMATE_ANSWERING,
        data: {
          channelId,
          teammateId: routingDecision.teammateId,
          routedSource: routingDecision.source,
          triggerMessageId: userMessageId,
        },
        workspaceId: workspaceId ?? channel.workspaceId ?? null,
        userId,
        channelId,
      });
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
            ...mcpServersList.filter((s) => s.id !== resolvedService.serviceId),
            serviceMcpEntry,
          ]
        : [serviceMcpEntry];
    }

    // 8-minute hard deadline — if the IS hangs mid-stream, break out and
    // emit a complete event so the frontend is never permanently stuck.
    const streamDeadline = new AbortController();
    let streamDeadlineExceeded = false;
    const streamDeadlineTimer = setTimeout(
      () => {
        logger.error({ channelId }, "Stream deadline exceeded — aborting");
        streamDeadlineExceeded = true;
        streamDeadline.abort();
      },
      8 * 60 * 1000
    );
    // The durable cancellation flag is polled as well as using the local
    // controller. That makes a Stop request sent to another API replica
    // reach the worker currently executing this turn.
    const cancellationPoll = durableTurn
      ? setInterval(() => {
          void getChatTurnForUser({ turnId: durableTurn.id, userId })
            .then((turn) => {
              if (
                turn?.cancelRequested &&
                !turnAbortController?.signal.aborted
              ) {
                logger.info(
                  { channelId, turnId: durableTurn?.id },
                  "Observed durable chat cancellation"
                );
                turnAbortController?.abort();
              }
            })
            .catch((error) => {
              logger.warn(
                { err: error, turnId: durableTurn?.id },
                "Could not poll chat cancellation"
              );
            });
        }, 500)
      : undefined;

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

    let receivedStreamOutput = false;
    let turnCancelled = false;
    // `failure` carries the CLASSIFICATION across the throw (see
    // utils/ai-failure-error.ts). Without it the verdict computed below was
    // recomputed nowhere and simply lost at the tRPC boundary, which is what
    // made the SSE error frame hardcode `recoverable: false`. Null = no failure
    // class: either a user cancellation, or a path that never classified.
    let terminalTurnFailure:
      | {
          status: "failed" | "cancelled";
          error: string;
          failure: AiFailureDescription | null;
        }
      | undefined;
    const intelligenceRequest = {
      query: content,
      threadId: channelId,
      userId,
      agentId: resolvedAgentId,
      agentType: effectiveAgentType,
      agentConfig:
        Object.keys(effectiveAgentConfig).length > 0
          ? effectiveAgentConfig
          : undefined,
      projectId,
      workspaceId,
      sourceMessageId: userMessageId,
      agentUserId: agentUserId ?? resolvedService.agentUserId,
      mcpServers: mcpServersList,
      deepAnalysis: input.deepAnalysis,
      workspaceSettings: workspaceSettingsForIS,
      contextObjectType: channel.contextObjectType ?? undefined,
      contextObjectId: channel.contextObjectId ?? undefined,
      ...getPodCallback(),
      channelKind,
      focusSessionId: activeFocusSessionId,
      ...(turnContext ? { turnContext } : {}),
      ...(input.onboardingSkill
        ? { forcedSkillName: input.onboardingSkill }
        : {}),
    };
    try {
      // Both the durable Stop action and the hard deadline must interrupt
      // the actual Pod -> IS fetch, not merely stop consuming its iterator.
      const streamSignal = turnAbortController
        ? AbortSignal.any([turnAbortController.signal, streamDeadline.signal])
        : streamDeadline.signal;
      const streamRequest = withTurnStreamSignal(
        intelligenceRequest,
        streamSignal
      );
      const stream = resolvedService.client.sendMessageStream(streamRequest);

      for await (const chunk of stream) {
        if (streamDeadline.signal.aborted) {
          throw new Error("AI response timed out");
        }
        if (chunk.type === "chunk" && chunk.content) {
          receivedStreamOutput = true;
          fullContent += chunk.content;

          emitChatEvent({
            event: EventNames.CHAT_STREAM,
            data: {
              threadId: channelId,
              ...turnEnvelope("delta"),
              content: chunk.content,
              isComplete: false,
            },
            workspaceId: workspaceId ?? null,
            userId: userId,
            channelId,
          });
        } else if (chunk.type === "step" && chunk.step) {
          receivedStreamOutput = true;
          aiSteps.push(chunk.step);

          emitChatEvent({
            event: SERVER_CONVERSATION_EVENTS.AI_STEP,
            data: {
              threadId: channelId,
              messageId: userMessageId,
              step: chunk.step,
              ...(durableTurn
                ? {
                    turnId: durableTurn.id,
                    channelId,
                    seq: socketTurnSeq + 1,
                  }
                : {}),
            },
            workspaceId: workspaceId ?? null,
            userId: userId,
            channelId,
          });
          // Canonical Socket observer envelope for other Browser clients.
          // Keep the legacy ai:step event above for existing consumers.
          emitChatEvent({
            event: EventNames.CHAT_STREAM,
            data: {
              threadId: channelId,
              ...turnEnvelope("step"),
              step: chunk.step,
            },
            workspaceId: workspaceId ?? null,
            userId,
            channelId,
          });
        } else if (chunk.type === "entities" && chunk.entities) {
          hubResponse.entities = chunk.entities;
        } else if (chunk.type === "branch_decision" && chunk.decision) {
          hubResponse.branchDecision = chunk.decision;

          emitChatEvent({
            event: SERVER_CONVERSATION_EVENTS.BRANCH_DECISION,
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
            event: SERVER_CONVERSATION_EVENTS.ROUTE_TO_CHANNEL,
            data: {
              threadId: channelId,
              messageId: userMessageId,
              routing: (chunk as any).routing,
            },
            workspaceId: workspaceId ?? null,
            userId: userId,
            channelId,
          });

          // Phase 3B: parallel typed emit for the eve-dashboard channels viz.
          // The legacy `route_to_channel` event above stays for backwards-compat.
          // Internal Synap-to-Synap routing → targetPlatform="synap"; the
          // viz layer can distinguish that from external relay routes when
          // OpenClaw-side outbound emit lands.
          const routingPayload = (chunk as { routing?: { reason?: string } })
            .routing;
          void emitTyped(
            "synap:reply:routed",
            {
              channelId,
              messageId: userMessageId,
              targetPlatform: "synap",
              excerpt: makeExcerpt(routingPayload?.reason ?? content),
              routedAt: new Date().toISOString(),
            },
            {
              workspaceId: workspaceId ?? undefined,
              userId,
              channelId,
            }
          ).catch((err) => {
            logger.warn(
              { err, event: "synap:reply:routed", channelId },
              "emitTyped failed"
            );
          });
        } else if (chunk.type === "proposal" && chunk.proposal) {
          const proposal = chunk.proposal;
          if (
            !createdProposals.some(
              (item) => item.proposalId === proposal.proposalId
            )
          ) {
            createdProposals.push(proposal);
            emittedProposalIds.add(proposal.proposalId);
            emitChatEvent({
              event: EventNames.AI_PROPOSAL,
              data: {
                threadId: channelId,
                messageId: userMessageId,
                proposalId: proposal.proposalId,
                toolName: proposal.toolName,
                description: proposal.description,
                agentUserId: agentUserId ?? resolvedService.agentUserId,
                ...(durableTurn
                  ? {
                      turnId: durableTurn.id,
                      channelId,
                      seq: socketTurnSeq + 1,
                    }
                  : {}),
              },
              workspaceId: workspaceId ?? null,
              userId,
              channelId,
            });
            emitChatEvent({
              event: EventNames.CHAT_STREAM,
              data: {
                threadId: channelId,
                ...turnEnvelope("proposal"),
                proposal: {
                  proposalId: proposal.proposalId,
                  toolName: proposal.toolName,
                  description: proposal.description,
                },
              },
              workspaceId: workspaceId ?? null,
              userId,
              channelId,
            });
          }
        } else if (chunk.type === "error") {
          // An IS SSE error is terminal for this turn. Treat it like a
          // transport failure so the established non-streaming fallback can
          // recover; otherwise the loop would persist a blank or partial
          // assistant message as if the response succeeded.
          // Carry the IS's structured failure evidence on the thrown error so
          // the failure door classifies on `code`/`retryable` rather than on
          // the prose. `chunk.error` stays the message for logs.
          throw Object.assign(
            new Error(chunk.error ?? "Intelligence service stream failed"),
            chunk.failure ? { failure: chunk.failure } : {}
          );
        } else if (chunk.type === "complete") {
          if (chunk.data) {
            const data = chunk.data as Partial<HubResponse>;
            hubResponse = { ...hubResponse, ...data };
            // ONE narrowing door, shared with the headless drain — see
            // is-chat-stream.ts. First one wins; a later clean complete on the
            // same turn must not erase a truncation we already observed.
            partialFailure =
              partialFailure ??
              narrowPartialFailure(
                (data as Record<string, unknown>).partialFailure
              );
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
              for (const proposal of incoming) {
                if (
                  !createdProposals.some(
                    (item) => item.proposalId === proposal.proposalId
                  )
                ) {
                  createdProposals.push(proposal);
                }
              }
            }
          }

          // Notify client of each proposal created during this AI response
          for (const cp of createdProposals) {
            if (emittedProposalIds.has(cp.proposalId)) continue;
            emittedProposalIds.add(cp.proposalId);
            emitChatEvent({
              event: EventNames.AI_PROPOSAL,
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
            event: EventNames.CHAT_STREAM,
            data: {
              threadId: channelId,
              type: "complete",
              isComplete: true,
              agentType: completedAgentType,
              // Live proposal chips must be available on the same terminal
              // event as the answer. The separate ai:proposal event remains
              // for existing observers.
              createdProposals,
              // Originating user message id — lets the FE pair this completion
              // to its trigger deterministically (replaces clock-skew guessing
              // in useCatchMeUp). Additive; existing consumers ignore it.
              triggerMessageId: userMessageId,
              // When the trigger was ephemeral (catch-me-up recap), flag the
              // completion so the room's useChannelStream skips promoting this
              // reply into the persisted message cache (it lives only in the
              // recap panel, never as a stray room-timeline message).
              ephemeral: input.ephemeral === true,
            },
            workspaceId: workspaceId ?? null,
            userId: userId,
            channelId,
          });
        }
      }
    } catch (streamError) {
      turnCancelled = turnAbortController?.signal.aborted === true;
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
        turnCancelled || receivedStreamOutput
          ? "Streaming stopped after output; preserving the single canonical turn"
          : "Streaming error before output, falling back to non-streaming"
      );

      // Once a sender has received any model/tool output, a non-streaming
      // retry could produce a different answer for the same durable user
      // message. Never make that second invocation. Cancellation is equally
      // terminal: the abort signal already reached the IS request.
      if (turnCancelled || streamDeadlineExceeded || receivedStreamOutput) {
        // A cancelled turn is not a failure — the user ended it — so it carries
        // no failure class. Everything else goes through the one door: the
        // deadline case has VERIFIED evidence (our own timer fired), the rest
        // is classified from the stream error itself.
        const streamFailure = turnCancelled
          ? null
          : describeAiFailure(
              streamDeadlineExceeded ? "timeout" : streamError,
              {
                reference: input.clientRequestId,
              }
            );
        const error = turnCancelled
          ? "Chat turn cancelled"
          : (streamFailure?.message ?? streamErrMsg);
        terminalTurnFailure = {
          status: turnCancelled ? "cancelled" : "failed",
          error,
          // Null for a cancellation — the user ended the turn, there is no
          // failure to classify. Everything else carries its real verdict.
          failure: streamFailure,
        };
        emitChatEvent({
          event: SERVER_CONVERSATION_EVENTS.CHAT_STREAM_ERROR,
          data: {
            threadId: channelId,
            error,
            fallback: false,
            cancelled: turnCancelled,
            // ADDITIVE wire contract (`error` unchanged): a stable code + an
            // evidence-derived retryable, so the browser stops offering a
            // Retry button for failures no retry can fix.
            ...(streamFailure
              ? {
                  code: streamFailure.code,
                  retryable: streamFailure.retryable,
                }
              : {}),
          },
          workspaceId: workspaceId ?? null,
          userId: userId,
          channelId,
        });
        emitChatEvent({
          event: EventNames.CHAT_STREAM,
          data: {
            threadId: channelId,
            ...turnEnvelope("error"),
            error: {
              code: turnCancelled ? "CHAT_TURN_CANCELLED" : "CHAT_TURN_FAILED",
              message: error,
              // Same defect as the SSE frame, same fix: the verdict is already
              // computed, so stop hardcoding a pessimistic constant over it.
              // Fail-safe — a cancellation (no failure class) stays false, as
              // does anything unclassified.
              recoverable: streamFailure?.retryable ?? false,
            },
          },
          workspaceId: workspaceId ?? null,
          userId,
          channelId,
        });
      } else {
        // Trigger auto-repair on auth errors so the next request succeeds
        if (isStreamAuthError) {
          try {
            const { markServiceCredentialError } =
              await import("../../utils/credential-auto-repair.js");
            markServiceCredentialError();
          } catch {
            /* best-effort */
          }
        }

        emitChatEvent({
          event: SERVER_CONVERSATION_EVENTS.CHAT_STREAM_ERROR,
          data: {
            threadId: channelId,
            error:
              streamError instanceof Error
                ? streamError.message
                : "Streaming failed",
            fallback: true,
            // `fallback: true` — the non-streaming retry is still in flight, so
            // this is progress, not a verdict. The code says WHAT failed; the
            // turn stays retryable because we are literally retrying it.
            code: describeAiFailure(streamError).code,
            retryable: true,
          },
          workspaceId: workspaceId ?? null,
          userId: userId,
          channelId,
        });

        try {
          hubResponse =
            await resolvedService.client.sendMessage(intelligenceRequest);
        } catch (fallbackError) {
          // Both stream and non-streaming fallback failed — Intelligence Hub is down
          const errorDetail =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          // ONE door from failure → user-facing words (utils/ai-failure.ts).
          // It classifies on real evidence (status / provider code / error
          // text) and never invents a cause or promises a retry that cannot
          // work — a 402 out-of-credit used to read as "temporarily
          // unavailable, try again shortly", which could never come true.
          const failure = describeAiFailure(fallbackError, {
            reference: input.clientRequestId,
          });

          logger.error(
            {
              err: fallbackError,
              channelId,
              failureClass: failure.class,
              retryable: failure.retryable,
            },
            "Both streaming and non-streaming IS calls failed"
          );

          // The response never began, so this is a terminal turn error rather
          // than an assistant reply. Persisting a synthetic error as an AI
          // message makes transcript identity and retry semantics ambiguous.
          if (failure.class === "auth") {
            // Auto-repair: request fresh credentials from CP in the background.
            // The current request fails gracefully, but the next one should succeed.
            try {
              const { markServiceCredentialError } =
                await import("../../utils/credential-auto-repair.js");
              markServiceCredentialError();
            } catch {
              // Non-critical — auto-repair is best-effort
            }
          }

          terminalTurnFailure = {
            status: "failed",
            error: failure.message,
            failure,
          };

          emitChatEvent({
            event: SERVER_CONVERSATION_EVENTS.CHAT_STREAM_ERROR,
            data: {
              threadId: channelId,
              // `error` is what the browser RENDERS (useChannelStream →
              // StreamError), so it carries the honest classified sentence;
              // the raw provider string stays available as `detail` for
              // diagnostics rather than being shown to the user.
              error: failure.message,
              detail: errorDetail,
              fallback: false,
              // Terminal verdict — the browser must not offer Retry unless the
              // evidence says a retry can actually succeed.
              code: failure.code,
              retryable: failure.retryable,
            },
            workspaceId: workspaceId ?? null,
            userId: userId,
            channelId,
          });
        }

        if (!terminalTurnFailure) {
          fullContent = hubResponse?.content || fullContent || "";
        }

        // Recover any proposals created during the (failed) stream or fallback response
        const fallbackProposals = hubResponse.createdProposals ?? [];
        if (fallbackProposals.length > 0) {
          for (const cp of fallbackProposals) {
            if (
              !createdProposals.some(
                (item) => item.proposalId === cp.proposalId
              )
            ) {
              createdProposals.push(cp);
            }
            if (emittedProposalIds.has(cp.proposalId)) continue;
            emittedProposalIds.add(cp.proposalId);
            emitChatEvent({
              event: EventNames.AI_PROPOSAL,
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
      }
    } finally {
      clearTimeout(streamDeadlineTimer);
      if (cancellationPoll) clearInterval(cancellationPoll);
      if (streamDeadlineExceeded && !terminalTurnFailure) {
        // Route the deadline through the SAME classifier as every other path
        // instead of a hand-written sentence. Our own timer firing IS the
        // evidence, so the class is `timeout` — which carries
        // `retryable: true`, the honest verdict for a deadline.
        const failure = describeAiFailure("timeout", {
          reference: input.clientRequestId,
        });
        terminalTurnFailure = {
          status: "failed",
          error: failure.message,
          failure,
        };
      }
    }

    if (terminalTurnFailure) {
      if (durableTurn) {
        await finishChatTurn({
          turnId: durableTurn.id,
          status: terminalTurnFailure.status,
          error: terminalTurnFailure.error,
        });
        completeActiveChatTurn(durableTurn.id);
      }
      // Carry the verdict ACROSS the boundary. A bare TRPCError holds only
      // code + message, so everything classified above used to die right here
      // and the SSE error frame had nothing left to report.
      throw new ChatTurnFailureError({
        message: terminalTurnFailure.error,
        failure: terminalTurnFailure.failure,
        cancelled: terminalTurnFailure.status === "cancelled",
      });
    }

    // Save assistant message — via the shared hash-chain writer
    // (persistAssistantReply), the same one the a2ai worker uses.
    // Provenance metadata: IS + agent that produced this message. Surfaces
    // a "Synap · agent-name" badge in chat clients (Eve, Relay, Studio).
    // Truncation verdict, translated ONCE from the IS's own code union into the
    // client's (`describePartialTurnFailure` — the unions differ). Used twice
    // below and both uses must agree: the live SSE `complete` frame, and the
    // persisted assistant row's metadata. Live-only would flash the affordance
    // and lose it on the first refetch — worse than never showing it.
    const partialTurnFailure: PartialTurnFailure | null = partialFailure
      ? describePartialTurnFailure(partialFailure)
      : null;
    if (partialFailure) {
      logger.warn(
        {
          channelId,
          userMessageId,
          // Raw provider text: DIAGNOSTIC ONLY, never rendered.
          isCode: partialFailure.code,
          isMessage: partialFailure.message,
          providerId: partialFailure.providerId,
        },
        "AI turn committed PARTIAL content after a mid-stream provider failure"
      );
    }

    const messageMetadata = {
      aiSteps,
      intelligenceServiceId: resolvedService.serviceId,
      agentId: resolvedAgentId,
      agentType: effectiveAgentType,
      // Durable half: a reloaded turn still renders the truncation.
      ...(partialTurnFailure ? { partialFailure: partialTurnFailure } : {}),
    };

    let persistedAssistantMessageId: string;
    let assistantMessageHash: string;
    try {
      const persisted = await persistAssistantReply({
        ...(durableTurn ? { assistantId: durableTurn.assistantMessageId } : {}),
        channelId,
        userMessageId,
        triggerContent: content,
        content: fullContent,
        userId,
        metadata: messageMetadata,
        sessionId: activeSessionId ?? null,
        // Mirror the trigger's transience: an ephemeral request gets an
        // ephemeral reply (live over socket, excluded from history).
        ephemeral: input.ephemeral === true,
        // Routed attribution: which teammate answered + how it was selected.
        // Null for non-routed (single-responder) messages — back-compat.
        routed: routingDecision
          ? {
              teammateId: routingDecision.teammateId,
              source:
                routingDecision.source === "mention"
                  ? RoutedSource.MENTION
                  : routingDecision.source === "orchestrator"
                    ? RoutedSource.ORCHESTRATOR
                    : RoutedSource.DIRECT,
            }
          : null,
      });
      persistedAssistantMessageId = persisted.assistantId;
      assistantMessageHash = persisted.hash;
    } catch (error) {
      if (durableTurn) {
        const detail =
          error instanceof Error
            ? error.message
            : "Could not persist the AI response";
        await finishChatTurn({
          turnId: durableTurn.id,
          status: "failed",
          error: detail,
        });
        completeActiveChatTurn(durableTurn.id);
      }
      throw error;
    }

    // The durable path preallocates the id; retain a defensive assertion so
    // a future writer change cannot silently reintroduce flash/reconciliation
    // bugs between the live bubble and persisted message.
    if (
      durableTurn &&
      persistedAssistantMessageId !== durableTurn.assistantMessageId
    ) {
      await finishChatTurn({
        turnId: durableTurn.id,
        status: "failed",
        error: "Persisted assistant message did not match chat turn",
      });
      completeActiveChatTurn(durableTurn.id);
      throw new Error("Persisted assistant message did not match chat turn");
    }

    if (durableTurn) {
      await finishChatTurn({
        turnId: durableTurn.id,
        status: turnCancelled ? "cancelled" : "completed",
      });
      completeActiveChatTurn(durableTurn.id);
      // Publish completion only after the assistant row is durable. The SSE
      // sender owns its own final frame; this envelope is for Socket
      // observers on other Browser clients.
      emitChatEvent({
        event: EventNames.CHAT_STREAM,
        data: {
          threadId: channelId,
          ...turnEnvelope("complete"),
          triggerMessageId: userMessageId,
          userMessageId,
          assistantMessageId: persistedAssistantMessageId,
          createdProposals,
        },
        workspaceId: workspaceId ?? null,
        userId,
        channelId,
      });
    }

    // Lazily enroll the human owner + AI agent in channel_members so
    // listRoomMembers returns real data for personal channels that were
    // created without explicit participants. Idempotent via onConflictDoNothing.
    const effectiveAgentUserId = agentUserId ?? resolvedService.agentUserId;
    if (effectiveAgentUserId) {
      db.insert(channelMembers)
        .values([
          {
            channelId,
            memberId: userId,
            memberKind: ChannelMemberKind.HUMAN,
            role: ChannelMemberRole.OWNER,
            addedBy: userId,
          },
          {
            channelId,
            memberId: effectiveAgentUserId,
            memberKind: ChannelMemberKind.AI_AGENT,
            role: ChannelMemberRole.MEMBER,
            addedBy: userId,
          },
        ])
        .onConflictDoNothing()
        .catch((err) =>
          logger.warn({ err, channelId }, "lazy channel_members enroll failed")
        );
    }

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
      event: EventNames.CHAT_MESSAGE,
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
      externalMeta.relayEnabled === true && externalMeta.connectorLive === true;
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
          channelType: ChannelType.SUB_THREAD,
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

    // channels.updatedAt was already bumped by persistAssistantReply (the
    // assistant-reply write) — no second update needed on this path.

    return {
      channelId,
      messageId: assistantMessageId,
      content: fullContent,
      entities: createdEntities,
      branchDecision,
      branchThread: branchChannel,
      aiSteps,
      createdProposals,
      // Live half: `chat-turn-sse.ts` spreads this result onto the `complete`
      // frame, so the codec sees it on the same terminal event as the answer.
      ...(partialTurnFailure ? { partialFailure: partialTurnFailure } : {}),
      ...(durableTurn
        ? {
            turnId: durableTurn.id,
            userMessageId: durableTurn.userMessageId,
            assistantMessageId: durableTurn.assistantMessageId,
          }
        : {}),
    };
  });
