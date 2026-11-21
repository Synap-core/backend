/**
 * Sockets opened with a pod app's ROOM TICKET live only as long as the app's
 * connection does (0438, board lane wb-room).
 *
 * A ticket is claimed once at the `/yjs` room gate; the socket then stays
 * open for hours. Each such socket is tracked by the connection key that
 * asked for its ticket, and a sweep asks the database which tracked
 * connections still stand (`liveTicketConnections`: the key, or the live
 * successor of a pod app's rotated key in the same connection slot, and the
 * person still on the pod) and disconnects every socket of one that does not.
 * The device sweep (`device-sockets.ts`) is the same shape for device tokens.
 *
 * A failed read disconnects nothing: an unanswered question is not "ended".
 * The sweep runs again at the next tick.
 */
import { db } from "@synap/database";
import { liveTicketConnections } from "@synap/database/realtime-room-tickets";
import type { DeviceSocket } from "./device-sockets.js";

/** How often tracked connections are re-checked. */
export const TICKET_SWEEP_INTERVAL_MS = 15_000;

const socketsByConnection = new Map<string, Set<DeviceSocket>>();

/** Track a socket admitted on a ticket of `apiKeyId` until it disconnects. */
export function trackTicketSocket(socket: DeviceSocket, apiKeyId: string) {
  let sockets = socketsByConnection.get(apiKeyId);
  if (!sockets) socketsByConnection.set(apiKeyId, (sockets = new Set()));
  sockets.add(socket);
  socket.once("disconnect", () => {
    const set = socketsByConnection.get(apiKeyId);
    set?.delete(socket);
    if (set?.size === 0) socketsByConnection.delete(apiKeyId);
  });
}

/** The connection keys with an open ticket socket. */
export function trackedTicketConnections(): string[] {
  return [...socketsByConnection.keys()];
}

/**
 * Disconnect every socket of a tracked connection that no longer stands.
 * Returns the connection keys whose sockets were closed. Throws when it could
 * not be read, having closed nothing.
 */
export async function sweepTicketSockets(
  isLive: (apiKeyIds: string[]) => Promise<Set<string>> = (ids) =>
    liveTicketConnections(db, ids)
): Promise<string[]> {
  const tracked = trackedTicketConnections();
  if (tracked.length === 0) return [];
  const live = await isLive(tracked);
  const ended = tracked.filter((id) => !live.has(id));
  for (const id of ended) {
    for (const socket of socketsByConnection.get(id) ?? [])
      socket.disconnect(true);
    socketsByConnection.delete(id);
  }
  return ended;
}

/** Start the periodic sweep; returns its stop. */
export function startTicketSocketSweep(
  intervalMs: number = TICKET_SWEEP_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    sweepTicketSockets().catch((err) => {
      console.error(
        "[Realtime] App connection liveness unavailable; ticket sockets kept until the next sweep:",
        err
      );
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
