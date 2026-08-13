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

import { TRPCError } from "@trpc/server";
import { db, eq, and, inArray } from "@synap/database";
import {
  channelMembers,
  ChannelMemberKind,
  ChannelMemberRole,
  users,
  workspaceMembers,
} from "@synap/database/schema";

import { emitChatEvent } from "../../utils/chat-realtime-broadcast.js";

import { assertChannelMembershipAccess } from "./helpers.js";

export const membershipProcedures = {
  /**
   * Add an AI teammate to a channel with per-channel capability flags.
   *
   * Auth: the caller must be the channel owner OR a channel member, AND (when
   * the channel is workspace-scoped) a member of that workspace. The teammate
   * being added must itself be a member of the channel's workspace — no
   * cross-tenant grants. Idempotent on (channelId, agentUserId): re-adding an
   * existing teammate updates its capability flags.
   *
   * Capability defaults mirror the schema floor: canDraft+canPropose, NOT
   * canAct. can_act is opt-in only.
   */
  addTeammate: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        /** Agent-user id (lives in `users`, userType='agent') to add. */
        agentUserId: z.string().uuid(),
        canDraft: z.boolean().default(true),
        canPropose: z.boolean().default(true),
        canAct: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await assertChannelMembershipAccess(
        input.channelId,
        ctx.userId
      );

      // The teammate must be an agent user that belongs to the channel's
      // workspace — no cross-tenant teammate grants. Pod-wide channels
      // (no workspaceId) skip the workspace check but still require an agent row.
      const [agentUser] = await db
        .select({ id: users.id, userType: users.userType })
        .from(users)
        .where(
          and(eq(users.id, input.agentUserId), eq(users.userType, "agent"))
        )
        .limit(1);
      if (!agentUser) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "agentUserId does not reference an agent user",
        });
      }
      if (channel.workspaceId) {
        const wsMembership = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, channel.workspaceId),
            eq(workspaceMembers.userId, input.agentUserId)
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

      const existing = await db.query.channelMembers.findFirst({
        where: and(
          eq(channelMembers.channelId, input.channelId),
          eq(channelMembers.memberId, input.agentUserId)
        ),
        columns: { id: true },
      });

      if (existing) {
        await db
          .update(channelMembers)
          .set({
            memberKind: ChannelMemberKind.AI_AGENT,
            canDraft: input.canDraft,
            canPropose: input.canPropose,
            canAct: input.canAct,
          })
          .where(eq(channelMembers.id, existing.id));
      } else {
        await db.insert(channelMembers).values({
          channelId: input.channelId,
          memberId: input.agentUserId,
          memberKind: ChannelMemberKind.AI_AGENT,
          role: ChannelMemberRole.MEMBER,
          canDraft: input.canDraft,
          canPropose: input.canPropose,
          canAct: input.canAct,
          addedBy: ctx.userId,
        });
      }

      emitChatEvent({
        event: "channel:updated",
        data: { channelId: input.channelId, userId: ctx.userId },
        workspaceId: channel.workspaceId ?? ctx.workspaceId ?? null,
        userId: ctx.userId,
      });

      return { status: "added" as const, channelId: input.channelId };
    }),

  /**
   * Remove an AI teammate from a channel. Same auth model as addTeammate.
   * Only ai_agent members can be removed here — human membership is managed by
   * the group-channel flows.
   */
  removeTeammate: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        agentUserId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const channel = await assertChannelMembershipAccess(
        input.channelId,
        ctx.userId
      );

      await db
        .delete(channelMembers)
        .where(
          and(
            eq(channelMembers.channelId, input.channelId),
            eq(channelMembers.memberId, input.agentUserId),
            eq(channelMembers.memberKind, ChannelMemberKind.AI_AGENT)
          )
        );

      emitChatEvent({
        event: "channel:updated",
        data: { channelId: input.channelId, userId: ctx.userId },
        workspaceId: channel.workspaceId ?? ctx.workspaceId ?? null,
        userId: ctx.userId,
      });

      return { status: "removed" as const, channelId: input.channelId };
    }),

  /**
   * List the members of a room: humans + AI teammates, each with kind, role,
   * capability flags, and — for teammates — the agent identity the UI needs
   * (agentType, name, avatar). Read access requires channel access.
   */
  listRoomMembers: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      await assertChannelMembershipAccess(input.channelId, ctx.userId);

      const memberRows = await db
        .select({
          memberId: channelMembers.memberId,
          memberKind: channelMembers.memberKind,
          role: channelMembers.role,
          canDraft: channelMembers.canDraft,
          canPropose: channelMembers.canPropose,
          canAct: channelMembers.canAct,
          addedBy: channelMembers.addedBy,
          createdAt: channelMembers.createdAt,
        })
        .from(channelMembers)
        .where(eq(channelMembers.channelId, input.channelId));

      if (memberRows.length === 0) return { members: [] };

      // Resolve identity for every member (human or agent) in one query.
      const memberIds = memberRows.map((m) => m.memberId);
      const identityRows = await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatarUrl: users.avatarUrl,
          userType: users.userType,
          agentType: users.agentType,
        })
        .from(users)
        .where(inArray(users.id, memberIds));
      const identityById = new Map(identityRows.map((r) => [r.id, r]));

      const members = memberRows.map((m) => {
        const identity = identityById.get(m.memberId);
        const isAgent = m.memberKind === ChannelMemberKind.AI_AGENT;
        return {
          memberId: m.memberId,
          memberKind: m.memberKind,
          role: m.role,
          capabilities: {
            canDraft: m.canDraft,
            canPropose: m.canPropose,
            canAct: m.canAct,
          },
          addedBy: m.addedBy,
          createdAt: m.createdAt,
          name: identity?.name ?? null,
          email: identity?.email ?? null,
          avatarUrl: identity?.avatarUrl ?? null,
          // Agent identity the UI needs to render a teammate chip.
          agent: isAgent ? { agentType: identity?.agentType ?? null } : null,
        };
      });

      return { members };
    }),

  // ── Reactions ──────────────────────────────────────────────────────────────
};
