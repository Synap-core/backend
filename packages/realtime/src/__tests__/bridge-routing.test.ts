/**
 * Every HTTP request to the realtime port gets an answer.
 *
 * The defect this pins: a path that was neither a bridge endpoint nor exactly
 * `/health` was handed to Socket.IO, which ignores paths outside `/socket.io/`
 * and never responds, so the request HUNG (Caddy's public `/realtime/*` route
 * did that), and `/health/yjs`, which the bridge implements, was unreachable.
 *
 * A real http server + a real Socket.IO server, as server.ts wires them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { Server as SocketIOServer } from "socket.io";
import { routeHttpRequest, setupBridge } from "../bridge.js";

let httpServer: Server;
let io: SocketIOServer;
let base: string;

beforeAll(async () => {
  httpServer = createServer();
  io = new SocketIOServer(httpServer, { path: "/socket.io/" });
  setupBridge(io, httpServer, () => ({ documents: new Map() }));
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  io.close();
  await new Promise((r) => httpServer.close(r));
});

/** GET with a short deadline: a hang is a failure, not a slow pass. */
function get(path: string) {
  return fetch(base + path, { signal: AbortSignal.timeout(2000) });
}

describe("realtime HTTP routing", () => {
  it("an unknown path gets a 404 instead of hanging", async () => {
    for (const path of ["/realtime/anything", "/", "/favicon.ico"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it("/health/yjs is served by the bridge", async () => {
    const res = await get("/health/yjs");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ activeRooms: 0 });
  });

  it("the Socket.IO path still reaches Socket.IO", async () => {
    const res = await get("/socket.io/?EIO=4&transport=polling");
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/"sid"/);
  });

  it("routeHttpRequest names an owner for each path", () => {
    expect(routeHttpRequest("/bridge/emit")).toBe("bridge");
    expect(routeHttpRequest("/bridge/health")).toBe("bridge");
    expect(routeHttpRequest("/yjs/room/state")).toBe("bridge");
    expect(routeHttpRequest("/health")).toBe("bridge");
    expect(routeHttpRequest("/health/yjs")).toBe("bridge");
    expect(routeHttpRequest("/socket.io/?EIO=4")).toBe("socket.io");
    expect(routeHttpRequest("/realtime/x")).toBe("not-found");
  });
});
