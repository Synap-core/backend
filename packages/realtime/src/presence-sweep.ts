/**
 * Open `/presence` sockets are re-checked while they stay open.
 *
 * The handshake gate (server.ts middleware + presence-rooms.ts) and the
 * `join-room` gate decide once, at entry. Without a re-check, a socket kept
 * streaming after its Kratos session was revoked, its API key was revoked, or
 * its user was removed from the workspace: only device tokens were swept
 * (device-sockets.ts), and a recovered connection skipped the middlewares.
 *
 * Each sweep asks, per socket:
 *   1. is its credential still the principal it was admitted as? No → disconnect;
 *   2. may it still join its handshake rooms? No → disconnect (the presence
 *      session is anchored there; a reconnect meets the handshake gate);
 *   3. may it still join each room it added with `join-room`? No → leave it.
 * A check that could not RUN (Kratos or the DB unreachable) is not a verdict:
 * the socket keeps what it has until the next sweep.
 */
import { validateRealtimeApiKey } from "./api-key-auth.js";
import { verifyHandshakeUser } from "./session-auth.js";
import {
  decidePrincipalJoinRoom,
  type RealtimePrincipal,
} from "./room-authz.js";
import { handshakeRooms } from "./presence-rooms.js";

/** How often open `/presence` sockets are re-checked. */
export const PRESENCE_SWEEP_INTERVAL_MS = 120_000;

/** The part of a Socket.IO socket the sweep needs. */
export interface SweptSocket {
  id: string;
  handshake: { auth: unknown };
  data: { principal?: RealtimePrincipal };
  rooms: Set<string>;
  leave(room: string): unknown;
  disconnect(close?: boolean): unknown;
}

export interface SweepResult {
  disconnected: boolean;
  /** Rooms the socket was made to leave. */
  left: string[];
}

/** true / false, or null when the check could not run. */
type Verdict = boolean | null;

async function stillAuthenticated(
  auth: Record<string, unknown>,
  principal: RealtimePrincipal
): Promise<Verdict> {
  if (principal.kind === "service") {
    const apiKey = typeof auth.apiKey === "string" ? auth.apiKey : "";
    try {
      const key = await validateRealtimeApiKey(apiKey);
      return key?.apiKeyId === principal.apiKeyId;
    } catch {
      return null;
    }
  }
  const identity = await verifyHandshakeUser(auth);
  if (identity.ok) return identity.userId === principal.userId;
  return identity.unavailable ? null : false;
}

async function mayStillJoin(
  room: string,
  principal: RealtimePrincipal
): Promise<Verdict> {
  try {
    return await decidePrincipalJoinRoom(room, principal);
  } catch {
    return null;
  }
}

export async function sweepPresenceSocket(
  socket: SweptSocket
): Promise<SweepResult> {
  const principal = socket.data.principal;
  if (!principal) {
    socket.disconnect(true);
    return { disconnected: true, left: [] };
  }
  const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;

  const authenticated = await stillAuthenticated(auth, principal);
  if (authenticated === false) {
    socket.disconnect(true);
    return { disconnected: true, left: [] };
  }
  if (authenticated === null) return { disconnected: false, left: [] };

  const { rooms: handshakeRoomIds, gates } = handshakeRooms(auth);
  for (const room of gates) {
    if ((await mayStillJoin(room, principal)) === false) {
      socket.disconnect(true);
      return { disconnected: true, left: [] };
    }
  }

  const left: string[] = [];
  for (const room of [...socket.rooms]) {
    if (
      room === socket.id ||
      room === `user:${principal.userId}` ||
      handshakeRoomIds.includes(room)
    ) {
      continue;
    }
    if ((await mayStillJoin(room, principal)) === false) {
      socket.leave(room);
      left.push(room);
    }
  }
  return { disconnected: false, left };
}

/** Start the periodic re-check of `sockets()`; returns its stop. */
export function startPresenceSweep(
  sockets: () => Iterable<SweptSocket>,
  intervalMs: number = PRESENCE_SWEEP_INTERVAL_MS
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return; // a slow sweep never overlaps the next one
    running = true;
    void (async () => {
      for (const socket of [...sockets()]) {
        try {
          const r = await sweepPresenceSocket(socket);
          if (r.disconnected || r.left.length > 0) {
            console.log(
              `[Presence] sweep ${socket.id}: ${r.disconnected ? "disconnected" : `left ${r.left.join(", ")}`}`
            );
          }
        } catch (err) {
          console.error(`[Presence] sweep of ${socket.id} failed:`, err);
        }
      }
    })().finally(() => {
      running = false;
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
