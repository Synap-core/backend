/**
 * The rooms a `/presence` handshake names, and the ONE gate they pass.
 *
 * The connection handler joins `view:<viewId | workspace:<workspaceId>>` and
 * `workspace:<workspaceId>` unasked, from values the CLIENT put in its
 * handshake. Each of them is authorized here, for every principal, before the
 * socket is accepted: a user's `viewId` used to be joined unchecked (only the
 * API-key branch ran the gate), so any pod user could sit in another user's
 * view room, or pass `viewId: "workspace:<other>"` to land in another space's
 * presence room, read its `board:place` / presence / typing stream and inject
 * events into it.
 *
 * `handshakeRooms` is the single derivation of those rooms, used both by the
 * gate (here) and by the joins (server.ts), so the two cannot drift apart.
 */
import { canPrincipalJoinRoom, type RealtimePrincipal } from "./room-authz.js";

export interface HandshakeRooms {
  /** The presence scope: the view, else the workspace-level view, else none (pod altitude). */
  effectiveViewId: string | null;
  /** The rooms the connection handler joins unasked (beside the socket's own `user:` room). */
  rooms: string[];
  /**
   * The rooms the gate checks to authorize `rooms`: `workspace:<id>` covers the
   * workspace room and the workspace-level view room; `view:<viewId>` covers
   * the view room. Every entry of `rooms` is covered by one of these.
   */
  gates: string[];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function handshakeRooms(
  auth: Record<string, unknown> | undefined
): HandshakeRooms {
  const viewId = nonEmptyString(auth?.viewId);
  const workspaceId = nonEmptyString(auth?.workspaceId);
  const effectiveViewId =
    viewId ?? (workspaceId ? `workspace:${workspaceId}` : null);

  const rooms: string[] = [];
  if (effectiveViewId) rooms.push(`view:${effectiveViewId}`);
  if (workspaceId) rooms.push(`workspace:${workspaceId}`);

  const gates: string[] = [];
  if (workspaceId) gates.push(`workspace:${workspaceId}`);
  if (viewId) gates.push(`view:${viewId}`);

  return { effectiveViewId, rooms, gates };
}

/**
 * The first handshake room `principal` may not join, or null when it may join
 * them all. A user and an API key pass the same gate (`canPrincipalJoinRoom`),
 * the one every later `join-room` passes too.
 */
export async function firstDeniedHandshakeRoom(
  auth: Record<string, unknown> | undefined,
  principal: RealtimePrincipal
): Promise<string | null> {
  for (const room of handshakeRooms(auth).gates) {
    if (!(await canPrincipalJoinRoom(room, principal))) return room;
  }
  return null;
}
