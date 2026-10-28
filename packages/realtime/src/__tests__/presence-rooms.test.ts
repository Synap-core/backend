/**
 * The `/presence` handshake rooms pass ONE gate for every principal.
 *
 * The defect this pins: the connection handler joined `view:<viewId>` (and,
 * with `viewId: "workspace:<other>"`, another space's presence room) for a
 * USER socket without any check — only the API-key branch ran the gate. Any
 * pod user could read a victim's view stream (board:place decks, presence,
 * typing, collaboration:event) and inject events into it.
 *
 * The gate itself (`canPrincipalJoinRoom`) is tested in room-authz.pglite;
 * here it is a fake policy, and the question is reachability: does every room
 * the handler joins get asked about, for a user as for a key?
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const allowed = new Set<string>();
const canPrincipalJoinRoom = vi.fn(async (room: string) => allowed.has(room));
vi.mock("../room-authz.js", () => ({
  canPrincipalJoinRoom: (room: string, principal: unknown) =>
    canPrincipalJoinRoom(room, principal),
}));

import { firstDeniedHandshakeRoom, handshakeRooms } from "../presence-rooms.js";

const user = { kind: "user" as const, userId: "attacker" };
const key = {
  kind: "service" as const,
  userId: "agent",
  ownerUserId: "human",
  workspaceId: null,
  apiKeyId: "k1",
};

beforeEach(() => {
  allowed.clear();
  canPrincipalJoinRoom.mockClear();
});

describe("handshake room gate", () => {
  it("refuses a USER whose viewId names a view they may not join", async () => {
    allowed.add("workspace:ws-mine");
    const denied = await firstDeniedHandshakeRoom(
      { userId: "attacker", workspaceId: "ws-mine", viewId: "victim-view" },
      user
    );
    expect(denied).toBe("view:victim-view");
  });

  it("refuses a USER who smuggles another space's presence room through viewId", async () => {
    allowed.add("workspace:ws-mine");
    const auth = { workspaceId: "ws-mine", viewId: "workspace:ws-victim" };
    // The handler would join `view:workspace:ws-victim` …
    expect(handshakeRooms(auth).rooms).toContain("view:workspace:ws-victim");
    // … so the gate is asked about exactly that room, and it is refused.
    expect(await firstDeniedHandshakeRoom(auth, user)).toBe(
      "view:workspace:ws-victim"
    );
  });

  it("refuses a USER whose workspaceId is not theirs", async () => {
    expect(
      await firstDeniedHandshakeRoom({ workspaceId: "ws-victim" }, user)
    ).toBe("workspace:ws-victim");
  });

  it("admits a member to their workspace and its workspace-level view room", async () => {
    allowed.add("workspace:ws-mine");
    const auth = { workspaceId: "ws-mine" };
    expect(await firstDeniedHandshakeRoom(auth, user)).toBeNull();
    expect(handshakeRooms(auth)).toEqual({
      effectiveViewId: "workspace:ws-mine",
      rooms: ["view:workspace:ws-mine", "workspace:ws-mine"],
      gates: ["workspace:ws-mine"],
    });
  });

  it("asks the same gate for an API key, with the key as the principal", async () => {
    allowed.add("workspace:ws-1");
    await firstDeniedHandshakeRoom({ workspaceId: "ws-1", viewId: "v" }, key);
    expect(canPrincipalJoinRoom).toHaveBeenCalledWith("workspace:ws-1", key);
    expect(canPrincipalJoinRoom).toHaveBeenCalledWith("view:v", key);
  });

  it("a pod-altitude socket names no room and needs no check", async () => {
    expect(await firstDeniedHandshakeRoom({ userId: "u" }, user)).toBeNull();
    expect(handshakeRooms({ userId: "u" }).rooms).toEqual([]);
    expect(canPrincipalJoinRoom).not.toHaveBeenCalled();
  });

  it("every room the handler joins is covered by a gate the principal passed", async () => {
    // Derived over the handshake shapes: for each, allow exactly the gates and
    // check each joined room is one of them or the workspace-level view room
    // of an allowed workspace gate.
    const shapes = [
      { workspaceId: "a" },
      { viewId: "v" },
      { workspaceId: "a", viewId: "v" },
      { workspaceId: "a", viewId: "workspace:b" },
      { viewId: "workspace:b" },
      { workspaceId: "", viewId: "" },
    ];
    for (const auth of shapes) {
      const { rooms, gates } = handshakeRooms(auth);
      for (const room of rooms) {
        const covered =
          gates.includes(room) ||
          gates.some((g) => g.startsWith("workspace:") && room === `view:${g}`);
        expect(covered, `${JSON.stringify(auth)} joins ${room}`).toBe(true);
      }
    }
  });
});

describe("server.ts runs the gate for every principal", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "server.ts"),
    "utf8"
  );

  it("the middleware gates the handshake rooms once, after both principal branches", () => {
    const mw = src.slice(
      src.indexOf("presenceNamespace.use("),
      src.indexOf('presenceNamespace.on("connection"')
    );
    const gate = mw.indexOf("firstDeniedHandshakeRoom(auth, principal)");
    expect(gate, "middleware does not call the room gate").toBeGreaterThan(-1);
    // After the user branch: a gate inside the key branch only is the defect.
    expect(gate).toBeGreaterThan(mw.indexOf("verifyHandshakeUser(auth)"));
    expect(gate).toBeGreaterThan(mw.indexOf("validateRealtimeApiKey(apiKey)"));
    // Accepting the socket comes after the gate.
    expect(mw.indexOf("socket.data.principal = principal")).toBeGreaterThan(
      gate
    );
  });

  it("the connection handler joins handshake rooms only through handshakeRooms", () => {
    const handler = src.slice(src.indexOf('presenceNamespace.on("connection"'));
    expect(handler).toContain("handshakeRooms(");
    // No hand-built view/workspace join from raw handshake values.
    expect(handler).not.toMatch(/socket\.join\(`(view|workspace):/);
  });
});
