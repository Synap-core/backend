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
import { protectedProcedure } from "../../trpc.js";
import { AccessContext } from "../../access/index.js";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";

import { channelVisibilityWhere } from "../../utils/channel-visibility.js";

import { queryChannelMessages } from "../../utils/query-channel-messages.js";

import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  desc,
  asc,
  and,
  gte,
  inArray,
  isNull,
  drizzleSql,
} from "@synap/database";
import {
  channels,
  channelMembers,
  messages,
  channelContextItems,
  MessageRole,
  type ChannelContextObjectType,
  ChannelContextRelationshipType,
  proposals,
  sessions,
  compactedStates,
  messageReactions,
} from "@synap/database/schema";

import { computeMessageHash } from "@synap/database";
import type { AIStep } from "@synap-core/types";

import { emitSideEffects } from "@synap/events";
import { searchService } from "@synap/search";

import { resolveContextItemNames } from "./helpers.js";

export const messagingProcedures = {
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
      // Reads through the ONE door (queryChannelMessages): the canonical
      // channel-visibility gate (workspace members see shared GROUP/AGENT_COLLAB/
      // EXTERNAL channels they don't own) + isNull(deletedAt) + ephemeral=false
      // are all owned by the helper, so a read can never forget them.
      const msgs = await queryChannelMessages(db, {
        userId: ctx.userId,
        channelId: input.threadId,
        order: "desc",
        limit: input.limit + 1,
        cursor: input.cursor,
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
   * Returns a paired turn-by-turn timeline for a channel.
   * Each turn = one user message + the AI assistant reply that followed it.
   * Compaction boundaries are detected via sessionId changes between turns.
   */
  getTimeline: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        limit: z.number().int().min(1).max(200).default(100),
      })
    )
    .query(async ({ input, ctx }) => {
      // 1. Fetch the base history through the ONE door (queryChannelMessages) —
      //    channel-visibility gate + isNull(deletedAt) + ephemeral=false owned
      //    by the helper. Oldest-first, up to limit*2 to cover pairs. The
      //    turn-pairing / session / compaction shaping stays below.
      const allMessages = await queryChannelMessages(db, {
        userId: ctx.userId,
        channelId: input.channelId,
        order: "asc",
        limit: input.limit * 2,
      });

      // 2. Pair messages into turns: user → assistant
      type RawMessage = (typeof allMessages)[number];
      interface Turn {
        userMessage: RawMessage;
        assistantMessage?: RawMessage;
      }
      const turns: Turn[] = [];
      let i = 0;
      while (i < allMessages.length) {
        const msg = allMessages[i];
        if (msg.role === MessageRole.USER) {
          const next = allMessages[i + 1];
          const assistantMsg =
            next?.role === MessageRole.ASSISTANT ? next : undefined;
          turns.push({ userMessage: msg, assistantMessage: assistantMsg });
          i += assistantMsg ? 2 : 1;
        } else {
          // Skip leading assistant messages (edge case)
          i++;
        }
        if (turns.length >= input.limit) break;
      }

      // 3. Fetch sessions for compaction boundary detection
      const channelSessions = await db.query.sessions.findMany({
        where: eq(sessions.channelId, input.channelId),
        orderBy: [asc(sessions.startedAt)],
      });

      // 4. Fetch compacted states to get continuityBlock per boundary
      const compacted = await db.query.compactedStates.findMany({
        where: eq(compactedStates.channelId, input.channelId),
        orderBy: [desc(compactedStates.version)],
      });
      // Map sessionId → continuityBlock from the state that session produced
      const continuityBySessionId = new Map<string, string>();
      for (const state of compacted) {
        if (state.sessionId) {
          continuityBySessionId.set(state.sessionId, state.continuityBlock);
        }
      }

      // 5. Fetch proposals linked to user messages in these turns
      const userMessageIds = turns.map((t) => t.userMessage.id);
      const turnProposals =
        userMessageIds.length > 0
          ? await db
              .select({
                id: proposals.id,
                sourceMessageId: proposals.sourceMessageId,
                proposalType: proposals.proposalType,
                data: proposals.data,
              })
              .from(proposals)
              .where(inArray(proposals.sourceMessageId, userMessageIds))
          : [];

      // Group by sourceMessageId for O(1) lookup per turn
      const proposalsByMsgId = new Map<
        string,
        Array<{ proposalId: string; toolName: string; description: string }>
      >();
      for (const p of turnProposals) {
        if (!p.sourceMessageId) continue;
        const existing = proposalsByMsgId.get(p.sourceMessageId) ?? [];
        const data = p.data as Record<string, unknown> | null;
        const description =
          (data?.title as string | undefined) ??
          (data?.summary as string | undefined) ??
          (data?.name as string | undefined) ??
          p.proposalType;
        existing.push({
          proposalId: p.id,
          toolName: p.proposalType,
          description,
        });
        proposalsByMsgId.set(p.sourceMessageId, existing);
      }

      // 6. Build the output turns
      const outputTurns = turns.map((turn, idx) => {
        const meta = turn.assistantMessage?.metadata as
          | {
              aiSteps?: unknown[];
              agentType?: string;
              agentId?: string;
            }
          | null
          | undefined;

        // Compaction boundary: sessionId changed between this turn's assistant
        // message and the next turn's user message
        const nextTurn = turns[idx + 1];
        const currentSessionId =
          turn.assistantMessage?.sessionId ?? turn.userMessage.sessionId;
        const nextSessionId = nextTurn?.userMessage.sessionId ?? null;
        const isCompactionBoundary =
          currentSessionId !== null &&
          nextSessionId !== null &&
          currentSessionId !== nextSessionId;

        const compactionSummary =
          isCompactionBoundary && currentSessionId
            ? (continuityBySessionId.get(currentSessionId) ?? "")
            : undefined;

        return {
          index: idx + 1,
          userMessage: {
            id: turn.userMessage.id,
            content: turn.userMessage.content ?? "",
            timestamp: turn.userMessage.timestamp,
          },
          assistantMessage: turn.assistantMessage
            ? {
                id: turn.assistantMessage.id,
                content: turn.assistantMessage.content ?? "",
                timestamp: turn.assistantMessage.timestamp,
                agentType: meta?.agentType,
                agentId: meta?.agentId,
              }
            : undefined,
          steps: (meta?.aiSteps ?? []) as AIStep[],
          isCompactionBoundary,
          compactionSummary,
          proposals: proposalsByMsgId.get(turn.userMessage.id) ?? [],
        };
      });

      return {
        turns: outputTurns,
        totalTurns: outputTurns.length,
        sessionCount: channelSessions.length,
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
      // Canonical channel visibility — workspace members can see context items
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

      const rows = await db.query.channelContextItems.findMany({
        where: and(...conditions),
      });
      const names = await resolveContextItemNames(
        rows,
        AccessContext.from(ctx)
      );
      const items = rows.map((row) => ({
        ...row,
        objectName: names.get(row.objectId) ?? null,
      }));

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

      // A pod-wide channel (workspaceId = NULL) is a real channel, not a 404 —
      // gate on existence, then let the nullable workspaceId flow into
      // assertWorkspaceWrite (which handles the pod-wide / owner case) and the
      // nullable channel_context_items.workspace_id column.
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found",
        });
      }

      // Gate on the channel's workspace/owner before injecting context into it.
      await assertWorkspaceWrite(db, ctx.userId, {
        workspaceId: channel.workspaceId,
        ownerId: channel.userId,
      });

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
      const deleted = await db
        .update(messages)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(messages.channelId, input.channelId),
            gte(messages.timestamp, anchor.timestamp),
            isNull(messages.deletedAt)
          )
        )
        .returning({ id: messages.id });

      // Typesense has no delete-by-filter — emit ONE delete side-effect per
      // soft-deleted message id so each drops out of the content index.
      for (const row of deleted) {
        emitSideEffects({
          subjectType: "channel_message",
          action: "delete",
          subjectId: row.id,
          userId: ctx.userId,
          data: { channelId: input.channelId },
        });
      }

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
   * Edit the content of a message the caller authored.
   *
   * Conservative authz (mirrors the single-message ownership gate): only the
   * user who authored a NON-deleted message may edit it — assistant / other
   * users' messages are off-limits. The self-integrity hash is recomputed with
   * the canonical `computeMessageHash(id, content)` formula, so the edited row's
   * OWN hash stays self-consistent, and `edited_at` is stamped so the UI can
   * show "(edited)".
   *
   * NOTE — chain caveat: this does NOT re-derive downstream links. When this
   * message was the trigger for an assistant reply, that reply persisted its
   * `previousHash` from the ORIGINAL trigger content (`persist-assistant-reply.ts`),
   * so editing here breaks that one chain link for any downstream reply — the
   * reply's stored `previousHash` no longer matches this row's recomputed hash.
   * This is an accepted tradeoff (no consumer currently verifies the chain).
   */
  updateMessage: protectedProcedure
    .input(
      z.object({
        messageId: z.string().uuid(),
        content: z.string().min(1).max(50_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const msg = await db.query.messages.findFirst({
        where: eq(messages.id, input.messageId),
      });
      if (!msg || msg.deletedAt) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message not found",
        });
      }
      if (msg.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only edit your own messages",
        });
      }

      const [updated] = await db
        .update(messages)
        .set({
          content: input.content,
          hash: computeMessageHash(input.messageId, input.content),
          editedAt: new Date(),
        })
        .where(eq(messages.id, input.messageId))
        .returning();

      // Re-index the edited content in Typesense (message-content search).
      emitSideEffects({
        subjectType: "channel_message",
        action: "update",
        subjectId: input.messageId,
        userId: ctx.userId,
        data: { channelId: msg.channelId },
      });

      return { message: updated };
    }),

  /**
   * Soft-delete a SINGLE message the caller authored (sets `deleted_at`).
   * Complements the range-based `deleteMessagesFrom`. Idempotent.
   */
  deleteMessage: protectedProcedure
    .input(z.object({ messageId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const msg = await db.query.messages.findFirst({
        where: eq(messages.id, input.messageId),
      });
      if (!msg) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message not found",
        });
      }
      if (msg.userId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only delete your own messages",
        });
      }

      await db
        .update(messages)
        .set({ deletedAt: new Date() })
        .where(
          and(eq(messages.id, input.messageId), isNull(messages.deletedAt))
        );

      // Remove from the Typesense message-content index.
      emitSideEffects({
        subjectType: "channel_message",
        action: "delete",
        subjectId: input.messageId,
        userId: ctx.userId,
        data: { channelId: msg.channelId },
      });

      return { success: true as const };
    }),

  /**
   * List pinned messages for a channel (oldest → newest).
   *
   * A message is pinned when its `metadata.pinned` JSONB flag is truthy. Read
   * access is gated by the canonical `channelVisibilityWhere` predicate — the
   * same gate `getMessages` / `getTimeline` use — so workspace members see
   * pins in shared channels they don't own.
   */
  listPinnedMessages: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Reads through the ONE door (queryChannelMessages): channel-visibility
      // gate + isNull(deletedAt) + ephemeral=false owned by the helper. The
      // pinned-metadata filter rides along as an extra predicate on the triad.
      const pinned = await queryChannelMessages(db, {
        userId: ctx.userId,
        channelId: input.channelId,
        order: "asc",
        extraWhere: drizzleSql`${messages.metadata}->>'pinned' = 'true'`,
      });

      return { messages: pinned };
    }),

  /**
   * Full-text search over message CONTENT within a single channel (Typesense).
   *
   * RLS crux: visibility is proven by the DB channel-access gate FIRST — the
   * SAME canonical `channelVisibilityWhere` predicate `getMessages` /
   * `listPinnedMessages` use. Only after that passes do we query Typesense,
   * HARD-pinned to this one `channelId`. We never rely on Typesense's static
   * `userId:=` field for visibility (channels are multi-author / shared): the DB
   * check is the gate; the Typesense filter is `channelId:=<id>` only.
   */
  searchMessages: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        query: z.string().min(1).max(500),
        limit: z.number().min(1).max(50).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
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

      return searchService.searchCollection("messages", input.query, {
        userId: ctx.userId,
        channelId: input.channelId,
        limit: input.limit,
      });
    }),

  /**
   * Pin or unpin a single message.
   *
   * Unlike `patchMessageMetadata` (owner-only, for personal feed actions), a pin
   * belongs to the SHARED channel surface: Rooms are multi-party `agent_collab`
   * channels where any workspace member — not just the creator — may pin. Authz
   * therefore MIRRORS the READ gate in `listPinnedMessages`: after loading the
   * message we load its channel through the canonical `channelVisibilityWhere`
   * predicate and reject (NOT_FOUND / access denied) if it isn't visible — the
   * same gate `getMessages` / `getTimeline` use. Soft-deleted messages are
   * rejected. The `metadata.pinned` flag is MERGED into the existing JSONB (the
   * same technique `patchMessageMetadata` uses) so sibling keys are preserved.
   */
  setMessagePinned: protectedProcedure
    .input(
      z.object({
        messageId: z.string().uuid(),
        pinned: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const msg = await db.query.messages.findFirst({
        where: eq(messages.id, input.messageId),
      });
      if (!msg || msg.deletedAt) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Message not found",
        });
      }

      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, msg.channelId),
          channelVisibilityWhere(ctx.userId)
        ),
      });
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Channel not found or access denied",
        });
      }

      const existing = (msg.metadata ?? {}) as Record<string, unknown>;
      const merged: Record<string, unknown> = {};
      for (const k of Object.keys(existing)) {
        merged[k] = existing[k];
      }
      merged.pinned = input.pinned;

      const [updated] = await db
        .update(messages)
        .set({ metadata: merged as any })
        .where(eq(messages.id, input.messageId))
        .returning();

      return { success: true as const, message: updated };
    }),

  /**
   * Toggle an emoji reaction on a message. Idempotent: reacting again removes
   * the reaction. Returns the new state so optimistic UI can verify.
   */
  toggleReaction: protectedProcedure
    .input(
      z.object({
        messageId: z.string().uuid(),
        emoji: z.string().min(1).max(12),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const existing = await db.query.messageReactions.findFirst({
        where: and(
          eq(messageReactions.messageId, input.messageId),
          eq(messageReactions.userId, ctx.userId),
          eq(messageReactions.emoji, input.emoji)
        ),
      });
      if (existing) {
        await db
          .delete(messageReactions)
          .where(eq(messageReactions.id, existing.id));
        return { action: "removed" as const };
      }
      await db.insert(messageReactions).values({
        messageId: input.messageId,
        userId: ctx.userId,
        emoji: input.emoji,
      });
      return { action: "added" as const };
    }),

  /**
   * Fetch aggregated reactions for a set of message IDs (max 100).
   * Returns a map from messageId → [{ emoji, count, reactedByMe }].
   */
  getChannelReactions: protectedProcedure
    .input(z.object({ messageIds: z.array(z.string().uuid()).max(100) }))
    .query(async ({ input, ctx }) => {
      if (input.messageIds.length === 0) return { reactions: {} };
      const rows = await db
        .select()
        .from(messageReactions)
        .where(inArray(messageReactions.messageId, input.messageIds));

      // Aggregate: (messageId, emoji) → { count, reactedByMe }
      const agg = new Map<string, { count: number; reactedByMe: boolean }>();
      for (const r of rows) {
        const key = `${r.messageId}::${r.emoji}`;
        const e = agg.get(key) ?? { count: 0, reactedByMe: false };
        e.count++;
        if (r.userId === ctx.userId) e.reactedByMe = true;
        agg.set(key, e);
      }

      const result: Record<
        string,
        Array<{ emoji: string; count: number; reactedByMe: boolean }>
      > = {};
      for (const [key, entry] of agg) {
        const sep = key.indexOf("::");
        const msgId = key.slice(0, sep);
        const emoji = key.slice(sep + 2);
        (result[msgId] ??= []).push({ emoji, ...entry });
      }
      return { reactions: result };
    }),

  // ── Read state ─────────────────────────────────────────────────────────────

  /**
   * Mark a channel as read (sets channel_members.last_read_at = NOW()).
   * No-op when the caller is not a member (channel owner path).
   */
  markChannelRead: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      await db
        .update(channelMembers)
        .set({ lastReadAt: new Date() })
        .where(
          and(
            eq(channelMembers.channelId, input.channelId),
            eq(channelMembers.memberId, ctx.userId)
          )
        );
      return { ok: true };
    }),
};
