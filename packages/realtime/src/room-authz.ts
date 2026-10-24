/**
 * Who may join a realtime room — the gate of the `/presence` namespace, for
 * the rooms a handshake names and for every dynamic `join-room`. Rooms are
 * `<prefix>:<id>`; the gate must check membership/ownership per prefix, NOT
 * trust the caller (otherwise any socket reads any channel's stream by id).
 * An API-key socket (realtime:observe) passes the SAME per-prefix check as its
 * owner, narrowed by the key's bound workspace and grant (`canKeyJoinRoom`).
 */
import { db, and, eq, GrantRepository } from "@synap/database";
import { channels, workspaceMembers, views } from "@synap/database/schema";
import { canUserSeeChannel } from "@synap/database/channel-visibility";
import { permits } from "@synap/governance-policy/grants";
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

function parseRoom(roomId: string): { prefix: string; id: string } | null {
  const idx = roomId.indexOf(":");
  if (idx <= 0) return null;
  const id = roomId.slice(idx + 1);
  return id ? { prefix: roomId.slice(0, idx), id } : null;
}

async function decide(roomId: string, userId: string): Promise<boolean> {
  const room = parseRoom(roomId);
  if (!room) return false;
  const { prefix, id } = room;
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

/** A socket authenticated by an API key (`validateRealtimeApiKey`). */
export interface RealtimeKeyPrincipal {
  apiKeyId: string;
  /** The key's own user (an agent key: the agent's user) — its self room. */
  userId: string;
  /** Whose data the key reads: the linked human, else the key's own user. */
  ownerUserId: string;
  /** The workspace the key is bound to; null = pod-wide. */
  workspaceId: string | null;
}

export type RealtimePrincipal =
  | { kind: "user"; userId: string }
  | ({ kind: "service" } & RealtimeKeyPrincipal);

/** THE room gate of `/presence`: handshake rooms and every `join-room`. */
export function canPrincipalJoinRoom(
  roomId: string,
  principal: RealtimePrincipal
): Promise<boolean> {
  return principal.kind === "service"
    ? canKeyJoinRoom(roomId, principal)
    : canUserJoinRoom(roomId, principal.userId);
}

/**
 * Authorize an API-KEY principal joining a realtime room — the rule webhooks
 * follow for a key-bound subscription (D7, api `utils/webhook-delivery.ts`):
 *   1. its OWNER may join the room (`decide`, the people's check);
 *   2. the room's workspace is the key's bound workspace, when it has one;
 *   3. the key's live grant (`resolveForKey`: revoked/expired = deny-all)
 *      permits reading the room's subject there.
 * A room is a live STREAM of everything about its subject, so it is judged
 * as one read of that subject: a `workspace:` room is the space's event feed
 * (`event.read` in that space), a `channel:` room (chat, session and object
 * rooms) is `channel.read` of that channel, a `view:` room `view.read`. A
 * grant pinned to projects cannot be told apart per event, so it is refused
 * (`permits` fails closed with no project). The grant is read on every join,
 * so a narrowing binds the next join at once.
 *
 * `user:` rooms carry the owner's pod-wide events, which no grant can bound:
 * a key joins only its own user's room.
 */
export async function canKeyJoinRoom(
  roomId: string,
  key: RealtimeKeyPrincipal
): Promise<boolean> {
  try {
    return await decideForKey(roomId, key);
  } catch (err) {
    console.error(`[Presence] key join-room check failed: ${roomId}`, err);
    return false;
  }
}

async function decideForKey(
  roomId: string,
  key: RealtimeKeyPrincipal
): Promise<boolean> {
  const room = parseRoom(roomId);
  if (!room) return false;
  if (room.prefix === "user") return room.id === key.userId;
  if (!(await decide(roomId, key.ownerUserId))) return false;
  const subject = await roomSubject(room);
  if (!subject) return false;
  if (key.workspaceId && key.workspaceId !== subject.workspaceId) return false;
  const grant = await new GrantRepository(db).resolveForKey(key.apiKeyId);
  return grant.scopes.some((scope) =>
    permits(scope, {
      subject: subject.grantSubject,
      action: "read",
      workspaceId: subject.workspaceId ?? undefined,
      entityId: subject.entityId,
    })
  );
}

/** What a room streams, as a grant subject, and the workspace it lives in. */
async function roomSubject(room: { prefix: string; id: string }): Promise<{
  grantSubject: string;
  workspaceId: string | null;
  entityId?: string;
} | null> {
  switch (room.prefix) {
    case "workspace":
      return { grantSubject: "event", workspaceId: room.id };
    case "channel": {
      const c = await db.query.channels.findFirst({
        where: eq(channels.id, room.id),
        columns: { workspaceId: true },
      });
      return c
        ? {
            grantSubject: "channel",
            workspaceId: c.workspaceId,
            entityId: room.id,
          }
        : null;
    }
    case "view": {
      const v = await db.query.views.findFirst({
        where: eq(views.id, room.id),
        columns: { workspaceId: true },
      });
      return v
        ? {
            grantSubject: "view",
            workspaceId: v.workspaceId,
            entityId: room.id,
          }
        : null;
    }
    default:
      return null;
  }
}
