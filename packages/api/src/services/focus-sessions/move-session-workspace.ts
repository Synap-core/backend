/**
 * MOVE a session into another space (D12, ticket 78ecf251) — the floor and the
 * write, shared by the direct `updateFocusSession` path and the approved
 * `focus_session/update` executor so the two can never disagree.
 *
 * What moves, in ONE transaction:
 *   - `focus_sessions.workspaceId` — the point of the change;
 *   - its room channel's `workspaceId` + `scope` (the same rule the mint uses,
 *     `ensure-session-channel.ts`: a space ⇒ WORKSPACE, none ⇒ POD) — otherwise
 *     the session and its room disagree on lens;
 *   - its `artifacts` rows — the outputs lens follows the session.
 * What NEVER moves: the entities and documents the session produced. They are
 * records with their own home (one space per domain); `move_entities` exists.
 *
 * The floor: the caller must be able to WRITE the target space
 * (`assertWorkspaceWrite`; `null` = personal ⇒ only the session's owner), and
 * every human seated in the room must be a member of the target — a move
 * narrows the room's readers to that space's members (`sessionReadableWhere`
 * floors the roster branch on the session's workspace), so it is refused rather
 * than silently locking a participant out.
 */
import { TRPCError } from "@trpc/server";
import {
  artifacts,
  channelMembers,
  channels,
  ChannelMemberKind,
  ChannelScope,
  db,
  eq,
  and,
  focusSessions,
  getWorkspaceMembership,
  users,
  workspaces,
} from "@synap/database";
import { assertWorkspaceWrite } from "../../utils/workspace-write-access.js";
import { SESSION_ROOM_CONTEXT_TYPE } from "../../utils/channel-visibility.js";

type MovableSession = {
  id: string;
  userId: string;
  channelId: string | null;
};

export type SessionWorkspaceMoveCheck =
  { ok: true; workspaceName: string | null } | { ok: false; reason: string };

/** The floor for moving `session` to `workspaceId`, as `userId`. */
export async function checkSessionWorkspaceMove(args: {
  session: MovableSession;
  workspaceId: string | null;
  userId: string;
}): Promise<SessionWorkspaceMoveCheck> {
  const { session, workspaceId, userId } = args;
  try {
    await assertWorkspaceWrite(db, userId, {
      workspaceId,
      ownerId: session.userId,
    });
  } catch (err) {
    if (!(err instanceof TRPCError)) throw err;
    return {
      ok: false,
      reason: workspaceId
        ? `Cannot move this session into space ${workspaceId}: you cannot write there.`
        : "Only the session's owner can make it personal.",
    };
  }
  if (!workspaceId) return { ok: true, workspaceName: null };

  if (session.channelId) {
    // Human seats on the session's OWN minted room (the read roster).
    const seats = await db
      .select({ memberId: channelMembers.memberId })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .innerJoin(users, eq(users.id, channelMembers.memberId))
      .where(
        and(
          eq(channels.id, session.channelId),
          eq(channels.contextObjectType, SESSION_ROOM_CONTEXT_TYPE),
          eq(channels.contextObjectId, session.id),
          eq(channelMembers.memberKind, ChannelMemberKind.HUMAN),
          eq(users.userType, "human")
        )
      );
    const outside: string[] = [];
    for (const { memberId } of seats) {
      if (!(await getWorkspaceMembership(db, workspaceId, memberId))) {
        outside.push(memberId);
      }
    }
    if (outside.length > 0) {
      return {
        ok: false,
        reason: `Cannot move this session into space ${workspaceId}: ${outside.length} ${
          outside.length === 1 ? "person" : "people"
        } in its room ${outside.length === 1 ? "is" : "are"} not a member of that space and would lose access. Add them to the space first.`,
      };
    }
  }

  const [ws] = await db
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!ws) {
    return { ok: false, reason: `Space not found: ${workspaceId}` };
  }
  return { ok: true, workspaceName: ws.name };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Re-home the session, its room and its artifacts. Call inside a transaction
 * (`tx`) so the three never disagree; the produced entities are not touched.
 */
export async function applySessionWorkspaceMove(
  tx: Tx,
  args: {
    sessionId: string;
    channelId: string | null;
    workspaceId: string | null;
  }
): Promise<void> {
  const { sessionId, channelId, workspaceId } = args;
  await tx
    .update(focusSessions)
    .set({ workspaceId, updatedAt: new Date() })
    .where(eq(focusSessions.id, sessionId));
  if (channelId) {
    await tx
      .update(channels)
      .set({
        workspaceId,
        scope: workspaceId ? ChannelScope.WORKSPACE : ChannelScope.POD,
      })
      .where(
        and(
          eq(channels.id, channelId),
          eq(channels.contextObjectType, SESSION_ROOM_CONTEXT_TYPE),
          eq(channels.contextObjectId, sessionId)
        )
      );
  }
  await tx
    .update(artifacts)
    .set({ workspaceId })
    .where(eq(artifacts.sessionId, sessionId));
}
