/**
 * Who may join a realtime room — the gate of the `/presence` namespace, for
 * the rooms a handshake names and for every dynamic `join-room`. Rooms are
 * `<prefix>:<id>`; the gate must check the room's subject, NOT trust the
 * caller (otherwise any socket reads any channel's stream by id).
 *
 * The rule is THE access door's (`canJoinRoom`, `@synap/api/access-door`,
 * vendored): a room is one read of what it streams — a `workspace:` room the
 * space's read floor (Q-A2), a `channel:` / `view:` room that row through its
 * registered floor, a `user:` room its own person only. An API-key socket
 * (realtime:observe) is judged as its human, narrowed by the key's bound
 * workspace and its live grant.
 */
import { db, GrantRepository } from "@synap/database";
// Registers the object-room floors (a document's / entity's ONE room is
// joinable by exactly the object's readers — `channelVisibilityWhere` branch
// 5). Without it an object room fails CLOSED here: owner and roster only.
import "./vendor/document-access.js";
import {
  canJoinRoom,
  userPrincipal,
  type Principal,
} from "./vendor/access-door.js";

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
export async function canPrincipalJoinRoom(
  roomId: string,
  principal: RealtimePrincipal
): Promise<boolean> {
  let p: Principal;
  try {
    p = await principalOf(principal);
  } catch (err) {
    // A grant that cannot be read denies: a gate that cannot decide denies.
    console.error(`[Presence] key grant read failed: ${roomId}`, err);
    return false;
  }
  return canJoinRoom(p, roomId);
}

/**
 * The door's principal for a socket. A key's grant is read on every join
 * (`resolveForKey`: revoked/expired = deny-all), so a narrowing binds the
 * next join at once.
 */
async function principalOf(principal: RealtimePrincipal): Promise<Principal> {
  if (principal.kind === "user") return userPrincipal(principal.userId);
  return {
    userId: principal.ownerUserId,
    grant: await new GrantRepository(db).resolveForKey(principal.apiKeyId),
    key: { userId: principal.userId, workspaceId: principal.workspaceId },
  };
}
