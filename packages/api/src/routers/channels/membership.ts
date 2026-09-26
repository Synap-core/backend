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
import { createLogger } from "@synap-core/core";
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
import { canUserSeeChannel } from "../../utils/channel-visibility.js";
import { NotificationService } from "../../notifications/NotificationService.js";
import {
  addRoomPerson,
  listRoomPersonCandidates,
  removeRoomPerson,
  roomPeopleAccess,
  RoomPeopleError,
} from "../../services/messaging/room-people.js";

const logger = createLogger({ module: "channels-membership" });

const canSee = (channelId: string, userId: string) =>
  canUserSeeChannel(db, channelId, userId);

/** A room-people refusal → the tRPC code a client can branch on. */
function toTrpcError(err: unknown): unknown {
  if (!(err instanceof RoomPeopleError)) return err;
  const code =
    err.reason === "not_found"
      ? "NOT_FOUND"
      : err.reason === "not_owner" || err.reason === "not_eligible"
        ? "FORBIDDEN"
        : "BAD_REQUEST";
  return new TRPCError({ code, message: err.message });
}

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
   * Add a PERSON (a human) to a session room — shares the room with them.
   * Owner-only; the person must already share the room's workspace (or, for a
   * pod-wide room, a workspace with its owner). Rules + rationale:
   * `services/messaging/room-people.ts`. Idempotent: adding someone already in
   * the room writes nothing and notifies nobody. No Hub/MCP twin in v1 — an
   * agent never adds a human.
   */
  addRoomMember: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        userId: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await addRoomPerson({
        channelId: input.channelId,
        callerId: ctx.userId,
        targetUserId: input.userId,
        canSee,
      }).catch((err: unknown) => {
        throw toTrpcError(err);
      });

      if (result.added) {
        // The added person's door into the room. `sourceId` is the channel, so
        // the registry's navigate-object action opens it through the route
        // table. Never fails the add: the roster row is the share.
        try {
          await NotificationService.create({
            type: "chat.room_member_added",
            userId: input.userId,
            workspaceId: result.room.workspaceId ?? null,
            sourceType: "system",
            sourceId: input.channelId,
            data: {
              inviterName: result.inviterName,
              roomTitle: result.room.title?.trim() || "a session room",
              channelId: input.channelId,
            },
          });
        } catch (err) {
          // Non-fatal — the person is in the room either way; say so loudly.
          logger.warn(
            { err, channelId: input.channelId, userId: input.userId },
            "room member added, but their notification could not be written"
          );
        }
        emitChatEvent({
          event: "channel:updated",
          data: { channelId: input.channelId, userId: ctx.userId },
          channelId: input.channelId,
          userId: ctx.userId,
        });
        // The added person is not in the channel room yet — reach their own
        // room so the shared room appears in their lists without a reload.
        emitChatEvent({
          event: "channel:updated",
          data: { channelId: input.channelId, userId: input.userId },
          userId: input.userId,
        });
      }

      return {
        status: result.added ? ("added" as const) : ("already_member" as const),
        channelId: input.channelId,
      };
    }),

  /**
   * Remove a PERSON from a session room. Owner-only; the room owner and the
   * session owner can never be removed.
   */
  removeRoomMember: protectedProcedure
    .input(
      z.object({
        channelId: z.string().uuid(),
        userId: z.string().min(1),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const result = await removeRoomPerson({
        channelId: input.channelId,
        callerId: ctx.userId,
        targetUserId: input.userId,
        canSee,
      }).catch((err: unknown) => {
        throw toTrpcError(err);
      });

      if (result.removed) {
        // The room's remaining readers, plus the removed person — who is no
        // longer in the audience but must drop the room from their lists.
        emitChatEvent({
          event: "channel:updated",
          data: { channelId: input.channelId, userId: ctx.userId },
          channelId: input.channelId,
          userId: ctx.userId,
        });
        emitChatEvent({
          event: "channel:updated",
          data: { channelId: input.channelId, userId: input.userId },
          userId: input.userId,
        });
      }

      return {
        status: result.removed ? ("removed" as const) : ("not_member" as const),
        channelId: input.channelId,
      };
    }),

  /** People the owner could add to a session room (owner-only). */
  listRoomMemberCandidates: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const candidates = await listRoomPersonCandidates({
        channelId: input.channelId,
        callerId: ctx.userId,
        canSee,
      }).catch((err: unknown) => {
        throw toTrpcError(err);
      });
      return { candidates };
    }),

  /**
   * List the members of a room: humans + AI teammates, each with kind, role,
   * capability flags, and — for teammates — the agent identity the UI needs
   * (agentType, name, avatar). Read access requires channel access.
   */
  listRoomMembers: protectedProcedure
    .input(z.object({ channelId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const channel = await assertChannelMembershipAccess(
        input.channelId,
        ctx.userId
      );
      // The ONE answer to "may this viewer add/remove people" — the same rule
      // `addRoomMember` / `removeRoomMember` enforce, so the UI never offers a
      // door that refuses.
      const peopleAccess = await roomPeopleAccess(channel, ctx.userId);
      const viewerCanManagePeople = peopleAccess.canManage;

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

      if (memberRows.length === 0)
        return { members: [], viewerCanManagePeople };

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
          // Whether the VIEWER may remove this person (`removeRoomMember`).
          // Agents leave through `removeTeammate`, never here.
          viewerCanRemove: !isAgent && peopleAccess.canRemove(m.memberId),
        };
      });

      return { members, viewerCanManagePeople };
    }),

  // ── Reactions ──────────────────────────────────────────────────────────────
};
