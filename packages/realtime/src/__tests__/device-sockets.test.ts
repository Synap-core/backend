/**
 * A socket opened with a device token closes when its device ends
 * (`device-sockets.ts`): the sweep closes every socket of a device the
 * database no longer calls live, and only those; a failed read closes
 * nothing. The liveness rules themselves (`liveDeviceIds`) are driven on
 * PGlite in the api's device suite; the `/yjs` gate's tracking is in
 * `yjs-room-auth.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@synap/database", () => ({ db: {} }));
vi.mock("@synap/database/person-devices", () => ({
  liveDeviceIds: vi.fn(),
}));

import {
  sweepDeviceSockets,
  trackDeviceSocket,
  trackedDeviceIds,
  type DeviceSocket,
} from "../device-sockets.js";

function fakeSocket() {
  const listeners: Array<() => void> = [];
  const socket = {
    disconnected: false,
    disconnect: vi.fn(() => {
      socket.disconnected = true;
      for (const l of listeners) l();
    }),
    once: (_event: "disconnect", l: () => void) => listeners.push(l),
  };
  return socket satisfies DeviceSocket;
}

beforeEach(async () => {
  // Drain whatever a previous test left tracked.
  await sweepDeviceSockets(async () => new Set());
});

describe("the device socket sweep", () => {
  it("closes every socket of an ended device, and only those", async () => {
    const ended = [fakeSocket(), fakeSocket()];
    const live = fakeSocket();
    trackDeviceSocket(ended[0]!, "device-ended");
    trackDeviceSocket(ended[1]!, "device-ended");
    trackDeviceSocket(live, "device-live");

    const closed = await sweepDeviceSockets(async (ids) => {
      expect(ids.sort()).toEqual(["device-ended", "device-live"]);
      return new Set(["device-live"]);
    });

    expect(closed).toEqual(["device-ended"]);
    expect(ended.every((s) => s.disconnect.mock.calls.length === 1)).toBe(true);
    expect(live.disconnect).not.toHaveBeenCalled();
    expect(trackedDeviceIds()).toEqual(["device-live"]);
  });

  it("a failed liveness read closes nothing, and the socket stays tracked", async () => {
    const s = fakeSocket();
    trackDeviceSocket(s, "device-1");
    await expect(
      sweepDeviceSockets(async () => {
        throw new Error("database down");
      })
    ).rejects.toThrow("database down");
    expect(s.disconnect).not.toHaveBeenCalled();
    expect(trackedDeviceIds()).toEqual(["device-1"]);
  });

  it("a socket that disconnects on its own is forgotten", async () => {
    const s = fakeSocket();
    trackDeviceSocket(s, "device-2");
    s.disconnect();
    expect(trackedDeviceIds()).toEqual([]);
    const isLive = vi.fn(async () => new Set<string>());
    await sweepDeviceSockets(isLive);
    expect(isLive).not.toHaveBeenCalled();
  });

  it("every gate that verifies a handshake tracks the device it names", () => {
    // Derived: each source file that calls verifyHandshakeUser must hand the
    // identity's deviceId to trackDeviceSocket.
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const callers = readdirSync(src)
      .filter((f) => f.endsWith(".ts") && f !== "session-auth.ts")
      .filter((f) =>
        /verifyHandshakeUser\(/.test(readFileSync(join(src, f), "utf8"))
      );
    expect(callers.sort()).toEqual(["server.ts", "yjs-server.ts"]);
    for (const f of callers) {
      const code = readFileSync(join(src, f), "utf8");
      expect(code, f).toMatch(
        /trackDeviceSocket\(socket, (identity\.)?deviceId\)/
      );
    }
  });
});
