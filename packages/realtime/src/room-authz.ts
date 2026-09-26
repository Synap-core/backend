/**
 * Who may join a realtime room — the dynamic `join-room` gate of the
 * `/presence` namespace. Rooms are `<prefix>:<id>`; the gate must check
 * membership/ownership per prefix, NOT trust the caller (otherwise any socket
 * reads any channel's stream by id). Service-account observers
 * (realtime:observe) bypass this in server.ts.
 */
import { db, and, eq } from "@synap/database";
import { workspaceMembers, views } from "@synap/database/schema";
import { canUserSeeChannel } from "@synap/database/channel-visibility";
// Registers the object-room floors (a document's / entity's ONE room is
// joinable by exactly the object's readers — `channelVisibilityWhere` branch
// 5). Without it an object room fails CLOSED here: owner and roster only.
import "./vendor/document-access.js";

/** Is `userId` a member of `workspaceId`? */
async function isWorkspaceMember(
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const m = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
  });
  return !!m;
}

/**
 * Authorize a USER principal joining a realtime room.
 *
 * `channel:<id>` uses the channel READ predicate (`channelVisibilityWhere`, via
 * `canUserSeeChannel`) — the same rule every channel read and the api's chat
 * audience use. Workspace membership alone is NOT enough: a roster-only session
 * room or a private thread must not stream to every workspace member, and a
 * roster human outside the room's workspace must be able to join.
 */
export async function canUserJoinRoom(
  roomId: string,
  userId: string
): Promise<boolean> {
  try {
    return await decide(roomId, userId);
  } catch (err) {
    // e.g. a non-uuid id — a gate that cannot decide denies.
    console.error(`[Presence] join-room check failed: ${roomId}`, err);
    return false;
  }
}

async function decide(roomId: string, userId: string): Promise<boolean> {
  const idx = roomId.indexOf(":");
  if (idx <= 0) return false;
  const prefix = roomId.slice(0, idx);
  const id = roomId.slice(idx + 1);
  if (!id) return false;
  switch (prefix) {
    case "user":
      return id === userId;
    case "workspace":
      return isWorkspaceMember(id, userId);
    case "channel":
      return canUserSeeChannel(db, id, userId);
    case "view": {
      const v = await db.query.views.findFirst({
        where: eq(views.id, id),
        columns: { userId: true, workspaceId: true },
      });
      if (!v) return false;
      if (v.userId === userId) return true;
      return v.workspaceId ? isWorkspaceMember(v.workspaceId, userId) : false;
    }
    default:
      return false; // unknown prefix → deny
  }
}
