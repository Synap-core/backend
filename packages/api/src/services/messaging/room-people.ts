/**
 * Room PEOPLE — the rules behind "Add person" / "Remove" on a session room.
 *
 * A session room is roster-only (`channelVisibilityWhere` branch 2), so putting
 * a human on its roster is what shares the room with them. That makes this an
 * ACCESS decision, and every clause below is one:
 *
 * WHO MAY MANAGE PEOPLE — the room's owner (`channels.userId`, the human who
 * minted it) or the owner of the session it belongs to (`focus_sessions.userId`
 * — `ensureSessionChannel` enrols them as a member when a different human
 * minted the room). Nobody else: roster membership grants reading and posting,
 * never re-sharing.
 *
 * WHICH ROOMS — a session's OWN room only: stamped `contextObjectType =
 * SESSION_ROOM_CONTEXT_TYPE` AND `focus_sessions.channel_id = room.id`. The
 * stamp alone is forgeable (any caller can mint a thread stamped with someone
 * else's session id), so an unconfirmed stamp manages nobody — the same FK +
 * stamp pairing `sessionReadableWhere` reads. Other GROUP rooms are
 * workspace-visible, so a roster row there shares nothing, and their people
 * are chosen at creation (`createGroupChannel`).
 *
 * WHO MAY BE ADDED — a HUMAN (never an agent: `chat.addTeammate` is the agent
 * door) who already shares a tenant boundary with the room:
 *   - a workspace room → a member of THAT workspace (the same rule
 *     `createGroupChannel` and `addTeammate` apply — no cross-tenant grant; a
 *     stranger goes through the workspace invite first);
 *   - a pod-wide room (NULL workspace — an owner-private session) → someone who
 *     shares at least one workspace with the room's owner. A pod can hold
 *     accounts that never worked with the owner; "someone you already work
 *     with" is the narrowest boundary that exists at pod altitude, and it is
 *     the pod-level reading of the workspace rule above.
 *
 * WHO MAY BE REMOVED — any human member except the room owner and the session
 * owner (removing them would orphan the room from the person it belongs to).
 *
 * Writes go through `enrollRoomMember` (the ONE roster door, idempotent). No
 * Hub / MCP door calls this in v1: an agent never adds a human.
 */

import {
  db,
  and,
  eq,
  ne,
  inArray,
  channels,
  channelMembers,
  focusSessions,
  users,
  workspaceMembers,
} from "@synap/database";
import { ChannelMemberKind, ChannelMemberRole } from "@synap/database/schema";
import { enrollRoomMember } from "./enroll-room-member.js";
import { SESSION_ROOM_CONTEXT_TYPE } from "../../utils/channel-visibility.js";

type Room = typeof channels.$inferSelect;
/** The fields the ownership rule reads — any channel shape carries them. */
type RoomOwnership = Pick<
  Room,
  "userId" | "contextObjectType" | "contextObjectId"
>;

export type RoomPeopleRefusal =
  | "not_found"
  | "not_session_room"
  | "not_owner"
  | "not_a_person"
  | "not_eligible"
  | "cannot_remove_owner";

export class RoomPeopleError extends Error {
  constructor(
    readonly reason: RoomPeopleRefusal,
    message: string
  ) {
    super(message);
    this.name = "RoomPeopleError";
  }
}

export function isSessionRoom(room: Pick<Room, "contextObjectType">): boolean {
  return room.contextObjectType === SESSION_ROOM_CONTEXT_TYPE;
}

/**
 * The owners of a session's OWN room — its minter and its session's owner — or
 * `null` when the stamp is not confirmed by the session's `channel_id` (a
 * forged or borrowed stamp).
 */
async function ownSessionRoomOwnerIds(
  room: RoomOwnership & Pick<Room, "id">
): Promise<Set<string> | null> {
  if (!isSessionRoom(room) || !room.contextObjectId) return null;
  const session = await db.query.focusSessions.findFirst({
    where: eq(focusSessions.id, room.contextObjectId),
    columns: { userId: true, channelId: true },
  });
  if (!session || session.channelId !== room.id) return null;
  return new Set([room.userId, session.userId]);
}

/**
 * What `userId` may do to this room's people: manage them at all, and — per
 * member — remove them (never an owner). Never throws. The roster read
 * (`chat.listRoomMembers`) projects this so the UI offers exactly the doors
 * `addRoomPerson` / `removeRoomPerson` would honour.
 */
export async function roomPeopleAccess(
  room: RoomOwnership & Pick<Room, "id">,
  userId: string
): Promise<{ canManage: boolean; canRemove: (memberId: string) => boolean }> {
  const owners = await ownSessionRoomOwnerIds(room);
  if (!owners) return { canManage: false, canRemove: () => false };
  const canManage = owners.has(userId);
  return {
    canManage,
    canRemove: (memberId) => canManage && !owners.has(memberId),
  };
}

/**
 * Load the room and assert the caller may manage its people. A caller who
 * cannot even see the room gets `not_found` (the id tells them nothing).
 */
async function loadManagedRoom(
  channelId: string,
  callerId: string,
  canSee: (channelId: string, userId: string) => Promise<boolean>
): Promise<{ room: Room; owners: Set<string> }> {
  const room = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
  });
  if (!room || !(await canSee(channelId, callerId))) {
    throw new RoomPeopleError("not_found", "Room not found");
  }
  const owners = await ownSessionRoomOwnerIds(room);
  if (!owners) {
    throw new RoomPeopleError(
      "not_session_room",
      "People can only be added to a session room"
    );
  }
  if (!owners.has(callerId)) {
    throw new RoomPeopleError(
      "not_owner",
      "Only the room owner can change who is in the room"
    );
  }
  return { room, owners };
}

/** Human user ids who MAY be added to `room` (the eligibility rule above). */
async function eligibleHumanIds(
  room: Room,
  candidateIds?: string[]
): Promise<string[]> {
  const humansOnly = ne(users.userType, "agent");
  const narrow = candidateIds ? inArray(users.id, candidateIds) : undefined;
  if (room.workspaceId) {
    const rows = await db
      .selectDistinct({ id: users.id })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(
        and(
          eq(workspaceMembers.workspaceId, room.workspaceId),
          humansOnly,
          narrow
        )
      );
    return rows.map((r) => r.id);
  }
  const ownerWorkspaces = db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, room.userId));
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        inArray(workspaceMembers.workspaceId, ownerWorkspaces),
        humansOnly,
        narrow
      )
    );
  return rows.map((r) => r.id);
}

export interface RoomPersonCandidate {
  userId: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

/** People the owner could add: eligible humans not already on the roster. */
export async function listRoomPersonCandidates(p: {
  channelId: string;
  callerId: string;
  canSee: (channelId: string, userId: string) => Promise<boolean>;
}): Promise<RoomPersonCandidate[]> {
  const { room } = await loadManagedRoom(p.channelId, p.callerId, p.canSee);
  const eligible = await eligibleHumanIds(room);
  if (eligible.length === 0) return [];
  const rostered = new Set(
    (
      await db
        .select({ id: channelMembers.memberId })
        .from(channelMembers)
        .where(eq(channelMembers.channelId, room.id))
    ).map((r) => r.id)
  );
  const ids = eligible.filter((id) => !rostered.has(id));
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(inArray(users.id, ids));
  return rows.sort((a, b) =>
    (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? "")
  );
}

export interface AddRoomPersonResult {
  room: Room;
  /** `false` ⇒ already on the roster, nothing written, nobody notified. */
  added: boolean;
  /** Display name of whoever added them — for the notification. */
  inviterName: string;
}

export async function addRoomPerson(p: {
  channelId: string;
  callerId: string;
  targetUserId: string;
  canSee: (channelId: string, userId: string) => Promise<boolean>;
}): Promise<AddRoomPersonResult> {
  const { room } = await loadManagedRoom(p.channelId, p.callerId, p.canSee);

  const target = await db.query.users.findFirst({
    where: eq(users.id, p.targetUserId),
    columns: { id: true, userType: true },
  });
  if (!target || target.userType === "agent") {
    throw new RoomPeopleError(
      "not_a_person",
      "Only people can be added here — add an AI teammate from Teammates"
    );
  }
  const eligible = await eligibleHumanIds(room, [target.id]);
  if (!eligible.includes(target.id)) {
    throw new RoomPeopleError(
      "not_eligible",
      room.workspaceId
        ? "That person is not a member of this room's workspace"
        : "That person does not share a workspace with the room owner"
    );
  }

  const added = await enrollRoomMember(db, {
    channelId: room.id,
    userId: target.id,
    memberType: ChannelMemberKind.HUMAN,
    role: ChannelMemberRole.MEMBER,
    addedBy: p.callerId,
  });

  const inviter = await db.query.users.findFirst({
    where: eq(users.id, p.callerId),
    columns: { name: true, email: true },
  });
  return {
    room,
    added,
    inviterName: inviter?.name?.trim() || inviter?.email || "Someone",
  };
}

export async function removeRoomPerson(p: {
  channelId: string;
  callerId: string;
  targetUserId: string;
  canSee: (channelId: string, userId: string) => Promise<boolean>;
}): Promise<{ room: Room; removed: boolean }> {
  const { room, owners } = await loadManagedRoom(
    p.channelId,
    p.callerId,
    p.canSee
  );
  if (owners.has(p.targetUserId)) {
    throw new RoomPeopleError(
      "cannot_remove_owner",
      "The room owner cannot be removed"
    );
  }
  const deleted = await db
    .delete(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, room.id),
        eq(channelMembers.memberId, p.targetUserId),
        eq(channelMembers.memberKind, ChannelMemberKind.HUMAN)
      )
    )
    .returning({ id: channelMembers.id });
  return { room, removed: deleted.length > 0 };
}
