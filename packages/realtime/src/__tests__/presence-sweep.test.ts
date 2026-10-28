/**
 * Open `/presence` sockets are re-checked: a revoked session or key, or a
 * membership that ended, stops the stream; an unreachable Kratos or DB does not.
 *
 * The defect this pins: the gates decided once, at entry. A recovered
 * connection even skipped the middlewares (`skipMiddlewares: true`), and only
 * device tokens were swept, so a socket kept every room after its session was
 * revoked or its user was removed from the workspace.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const verifyHandshakeUser = vi.fn();
const validateRealtimeApiKey = vi.fn();
const decidePrincipalJoinRoom = vi.fn();
vi.mock("../session-auth.js", () => ({
  verifyHandshakeUser: (a: unknown) => verifyHandshakeUser(a),
}));
vi.mock("../api-key-auth.js", () => ({
  validateRealtimeApiKey: (k: unknown) => validateRealtimeApiKey(k),
}));
vi.mock("../room-authz.js", () => ({
  decidePrincipalJoinRoom: (r: unknown, p: unknown) =>
    decidePrincipalJoinRoom(r, p),
}));

import { sweepPresenceSocket, type SweptSocket } from "../presence-sweep.js";

const user = { kind: "user" as const, userId: "u1" };
const key = {
  kind: "service" as const,
  userId: "agent",
  ownerUserId: "u1",
  workspaceId: null,
  apiKeyId: "k1",
};

function socket(
  principal: SweptSocket["data"]["principal"],
  auth: Record<string, unknown>,
  rooms: string[]
) {
  const s = {
    id: "sock-1",
    handshake: { auth },
    data: { principal },
    rooms: new Set(["sock-1", ...rooms]),
    leave: vi.fn((r: string) => s.rooms.delete(r)),
    disconnect: vi.fn(),
  };
  return s;
}

const allowed = new Set<string>();
beforeEach(() => {
  vi.clearAllMocks();
  allowed.clear();
  verifyHandshakeUser.mockResolvedValue({ ok: true, userId: "u1" });
  validateRealtimeApiKey.mockResolvedValue({ apiKeyId: "k1" });
  decidePrincipalJoinRoom.mockImplementation(async (r: string) =>
    allowed.has(r)
  );
});

const auth = { userId: "u1", token: "t", workspaceId: "ws1" };
const rooms = ["user:u1", "view:workspace:ws1", "workspace:ws1", "channel:c1"];

describe("sweepPresenceSocket", () => {
  it("keeps a socket whose session, workspace and rooms all still hold", async () => {
    allowed.add("workspace:ws1").add("channel:c1");
    const s = socket(user, auth, rooms);
    expect(await sweepPresenceSocket(s)).toEqual({
      disconnected: false,
      left: [],
    });
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it("disconnects a user whose session was revoked", async () => {
    allowed.add("workspace:ws1").add("channel:c1");
    verifyHandshakeUser.mockResolvedValue({
      ok: false,
      error: "Realtime auth: invalid session",
    });
    const s = socket(user, auth, rooms);
    expect((await sweepPresenceSocket(s)).disconnected).toBe(true);
    expect(s.disconnect).toHaveBeenCalledWith(true);
  });

  it("disconnects a user removed from the handshake workspace", async () => {
    allowed.add("channel:c1");
    const s = socket(user, auth, rooms);
    expect((await sweepPresenceSocket(s)).disconnected).toBe(true);
  });

  it("makes a socket LEAVE a joined room it may no longer see, and keeps the rest", async () => {
    allowed.add("workspace:ws1");
    const s = socket(user, auth, rooms);
    expect(await sweepPresenceSocket(s)).toEqual({
      disconnected: false,
      left: ["channel:c1"],
    });
    expect(s.rooms.has("workspace:ws1")).toBe(true);
    // Its own rooms are never put to the gate.
    expect(decidePrincipalJoinRoom).not.toHaveBeenCalledWith(
      "user:u1",
      expect.anything()
    );
  });

  it("disconnects an API-key socket whose key was revoked", async () => {
    allowed.add("workspace:ws1");
    validateRealtimeApiKey.mockResolvedValue(null);
    const s = socket(key, { apiKey: "synap_user_x", workspaceId: "ws1" }, []);
    expect((await sweepPresenceSocket(s)).disconnected).toBe(true);
  });

  it("keeps everything when Kratos is unreachable (not a verdict)", async () => {
    verifyHandshakeUser.mockResolvedValue({
      ok: false,
      error: "Realtime auth: session validation unavailable",
      unavailable: true,
    });
    const s = socket(user, auth, rooms);
    expect(await sweepPresenceSocket(s)).toEqual({
      disconnected: false,
      left: [],
    });
  });

  it("keeps a room whose check could not run (DB blip)", async () => {
    allowed.add("workspace:ws1");
    decidePrincipalJoinRoom.mockImplementation(async (r: string) => {
      if (r === "channel:c1") throw new Error("connection terminated");
      return allowed.has(r);
    });
    const s = socket(user, auth, rooms);
    expect(await sweepPresenceSocket(s)).toEqual({
      disconnected: false,
      left: [],
    });
  });
});

describe("server.ts wiring", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "server.ts"),
    "utf8"
  );
  it("a recovered connection runs the auth middlewares again", () => {
    expect(src).toMatch(/skipMiddlewares:\s*false/);
    expect(src).not.toMatch(/skipMiddlewares:\s*true/);
  });
  it("the presence sweep is started over the /presence sockets", () => {
    expect(src).toMatch(
      /startPresenceSweep\(\s*\(\) => presenceNamespace\.sockets/
    );
  });
});
