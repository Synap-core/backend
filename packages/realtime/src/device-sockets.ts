/**
 * Sockets opened with a Synap app's DEVICE token live only as long as the
 * device does.
 *
 * The handshake resolves the token once (`verifyHandshakeUser`); a socket
 * then stays open for hours, past the device being signed out, reused,
 * evicted, or its person losing access to the pod. Each such socket is
 * tracked by its device here, and a sweep asks the database which tracked
 * devices are still live (`liveDeviceIds`, the same rules as the token
 * lookup) and disconnects every socket of one that is not, on `/presence`
 * and every `/yjs|<room>` alike.
 *
 * A failed read disconnects nothing: an unanswered question is not "ended".
 * The sweep runs again at the next tick.
 */
import { db } from "@synap/database";
import { liveDeviceIds } from "@synap/database/person-devices";

/** How often tracked devices are re-checked. */
export const DEVICE_SWEEP_INTERVAL_MS = 15_000;

/** The part of a Socket.IO socket this needs. */
export interface DeviceSocket {
  disconnect(close?: boolean): unknown;
  once(event: "disconnect", listener: () => void): unknown;
}

const socketsByDevice = new Map<string, Set<DeviceSocket>>();

/** Track a socket opened with `deviceId`'s token until it disconnects. */
export function trackDeviceSocket(socket: DeviceSocket, deviceId: string) {
  let sockets = socketsByDevice.get(deviceId);
  if (!sockets) socketsByDevice.set(deviceId, (sockets = new Set()));
  sockets.add(socket);
  socket.once("disconnect", () => {
    const set = socketsByDevice.get(deviceId);
    set?.delete(socket);
    if (set?.size === 0) socketsByDevice.delete(deviceId);
  });
}

/** The devices with an open socket. */
export function trackedDeviceIds(): string[] {
  return [...socketsByDevice.keys()];
}

/**
 * Disconnect every socket of a tracked device that is no longer live.
 * Returns the devices whose sockets were closed. Throws when liveness could
 * not be read, having closed nothing.
 */
export async function sweepDeviceSockets(
  isLive: (deviceIds: string[]) => Promise<Set<string>> = (ids) =>
    liveDeviceIds(db, ids)
): Promise<string[]> {
  const tracked = trackedDeviceIds();
  if (tracked.length === 0) return [];
  const live = await isLive(tracked);
  const ended = tracked.filter((id) => !live.has(id));
  for (const id of ended) {
    for (const socket of socketsByDevice.get(id) ?? []) socket.disconnect(true);
    socketsByDevice.delete(id);
  }
  return ended;
}

/** Start the periodic sweep; returns its stop. */
export function startDeviceSocketSweep(
  intervalMs: number = DEVICE_SWEEP_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    sweepDeviceSockets().catch((err) => {
      console.error(
        "[Realtime] Device liveness unavailable; sockets kept until the next sweep:",
        err
      );
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
