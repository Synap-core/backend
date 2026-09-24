/**
 * Ensure a focus session has a work channel (session room).
 *
 * Gate 2 / session-spine: ad-hoc createFocusSession historically left channelId
 * null; only runPlaybook minted a room. One helper keeps both doors consistent.
 *
 * Idempotent: if session.channelId is already set, returns it. Collision with
 * the partial unique "one active session per channel" is avoided by creating a
 * fresh room bound to this session as contextObject.
 *
 * THE ROOM IS A GROUP (founder decision 2026-09-24): several humans and agents
 * work in it, and an AI answers only when @-mentioned (`ONLY_MENTIONED`). Its
 * roster is seeded here, in the same transaction as the row:
 *   - the owner (HUMAN / OWNER) — and the session's owner, if different;
 *   - every agent on `focus_sessions.agentIds` (AI_AGENT);
 *   - the owner's personal orchestrator agent user (AI_AGENT), so "@ai"
 *     resolves against the roster (`resolveMentionedMember`).
 * The `contextObjectType = 'focus_session'` stamp is what makes the room
 * ROSTER-ONLY in `channelVisibilityWhere` — a GROUP is otherwise broadcast to
 * its workspace, or to the whole pod when it has none.
 */
import {
  db,
  focusSessions,
  channels,
  AiReactionMode,
  ChannelMemberKind,
  ChannelMemberRole,
  ChannelScope,
  ChannelStatus,
  ChannelType,
  eq,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { SESSION_ROOM_CONTEXT_TYPE } from "../../utils/channel-visibility.js";
import { ensurePersonalAgentUser } from "../../utils/personal-agent-user.js";
import { enrollRoomMember } from "../messaging/enroll-room-member.js";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";

const logger = createLogger({
  module: "focus-sessions/ensure-session-channel",
});

export async function ensureSessionChannel(args: {
  sessionId: string;
  userId: string;
  workspaceId?: string | null;
  goal?: string | null;
}): Promise<string | null> {
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, args.sessionId),
    columns: {
      id: true,
      channelId: true,
      title: true,
      goal: true,
      workspaceId: true,
      userId: true,
      agentIds: true,
    },
  });
  if (!session) return null;
  if (session.channelId) return session.channelId;

  const workspaceId = args.workspaceId ?? session.workspaceId ?? null;
  // The room is named like the session everywhere else: its title, else the
  // goal's first line — never a clipped paragraph.
  const title =
    resolveSessionTitle(
      { title: session.title, goal: args.goal ?? session.goal },
      { maxLength: 120 }
    ) || "Work session";

  // The owner's "@ai". Resolved BEFORE the transaction (it may create the
  // agent user); a failure costs the room its default AI member, never the room.
  let orchestratorId: string | null = null;
  try {
    orchestratorId = await ensurePersonalAgentUser(args.userId);
  } catch (err) {
    logger.warn(
      { err, sessionId: args.sessionId },
      "ensureSessionChannel: personal agent unresolved — room minted without @ai"
    );
  }

  try {
    return await db.transaction(async (tx) => {
      const [channel] = await tx
        .insert(channels)
        .values({
          userId: args.userId,
          workspaceId,
          channelType: ChannelType.GROUP,
          aiReactionMode: AiReactionMode.ONLY_MENTIONED,
          // Workspace-scoped when we have a home; otherwise pod-wide room.
          // (Scope is placement, not visibility — the room is roster-only.)
          scope: workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
          status: ChannelStatus.ACTIVE,
          title,
          contextObjectType: SESSION_ROOM_CONTEXT_TYPE,
          contextObjectId: session.id,
          metadata: {
            origin: "focus-session-create",
            sessionId: session.id,
          },
        })
        .returning({ id: channels.id });

      if (!channel?.id) return null;

      const humans = new Set([args.userId, session.userId]);
      for (const humanId of humans) {
        await enrollRoomMember(tx, {
          channelId: channel.id,
          userId: humanId,
          memberType: ChannelMemberKind.HUMAN,
          role:
            humanId === args.userId
              ? ChannelMemberRole.OWNER
              : ChannelMemberRole.MEMBER,
          addedBy: args.userId,
        });
      }
      const agentIds = new Set(
        [
          ...(Array.isArray(session.agentIds) ? session.agentIds : []),
          ...(orchestratorId ? [orchestratorId] : []),
        ].filter((id) => !!id && !humans.has(id))
      );
      for (const agentId of agentIds) {
        await enrollRoomMember(tx, {
          channelId: channel.id,
          userId: agentId,
          memberType: ChannelMemberKind.AI_AGENT,
          addedBy: args.userId,
        });
      }

      await tx
        .update(focusSessions)
        .set({ channelId: channel.id })
        .where(eq(focusSessions.id, session.id));

      return channel.id;
    });
  } catch (err) {
    // Best-effort: session without room is worse UX but must not fail create.
    logger.warn(
      { err, sessionId: args.sessionId },
      "ensureSessionChannel: failed to mint session room"
    );
    return null;
  }
}
