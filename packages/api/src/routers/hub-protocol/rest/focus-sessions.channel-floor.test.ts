/**
 * Hub `POST /focus-sessions` and `PATCH /focus-sessions/:id` refuse a
 * `channelId` the caller cannot read.
 *
 * A session's `channelId` is the room the judge and every room reader read AS
 * the session's: before this floor, any Hub caller could point a session at a
 * stranger's conversation and the criteria judge read it. The floor is the
 * canonical channel read door (`canUserSeeChannel`).
 *
 * POST: the floor lives in `createFocusSession` (every start door passes it;
 * pinned on PGlite by `create-session.room-floor.pglite.test.ts`). Here the
 * route must hand the service THIS caller and THIS room, and turn the
 * service's NOT_FOUND into a 404.
 * PATCH: this route writes the row itself, so the floor is asserted to be
 * asked for THIS channel and THIS caller, and a refusal must stop before the
 * membrane (nothing stored, nothing proposed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { db } from "@synap/database";
import type { HubHono, HubVariables } from "./_shared.js";

const USER_ID = "user-1";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const THEIR_ROOM = "22222222-2222-4222-8222-222222222222";
const MY_ROOM = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({
  seeCalls: [] as Array<[string, string]>,
  readable: new Set<string>(),
  created: [] as Array<Record<string, unknown>>,
  gated: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../utils/channel-visibility.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  canUserSeeChannel: async (
    _db: unknown,
    channelId: string,
    userId: string
  ) => {
    h.seeCalls.push([channelId, userId]);
    return h.readable.has(channelId);
  },
}));
vi.mock("../../../services/focus-sessions/create-session.js", async () => {
  const { TRPCError } = await import("@trpc/server");
  return {
    // Stands in for the service's own floor: refuses a room outside
    // `h.readable` exactly as `createFocusSession` refuses one.
    createFocusSession: async (p: Record<string, unknown>) => {
      h.created.push(p);
      if (p.channelId && !h.readable.has(p.channelId as string)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No channel" });
      }
      return {
        status: "created",
        session: { id: SESSION_ID, channelId: p.channelId },
      };
    },
  };
});
vi.mock("../../../utils/permission-check.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkPermissionOrPropose: async (p: Record<string, unknown>) => {
    h.gated.push(p);
    return { denied: true, reason: "stop here" };
  },
}));

const { registerFocusSessionsRoutes } = await import("./focus-sessions.js");

function app(): HubHono {
  const a: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  a.use("/*", async (c, next) => {
    c.set("userId", USER_ID);
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write"]);
    await next();
  });
  registerFocusSessionsRoutes(a);
  return a;
}

const send = (method: "POST" | "PATCH", path: string, body: unknown) =>
  app().request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Hub focus-sessions — a room the caller cannot read is refused", () => {
  let findFirstSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    h.seeCalls = [];
    h.readable = new Set([MY_ROOM]);
    h.created = [];
    h.gated = [];
    findFirstSpy = vi
      .spyOn(db.query.focusSessions, "findFirst")
      .mockResolvedValue({
        id: SESSION_ID,
        userId: USER_ID,
        workspaceId: null,
        goal: "g",
        status: "active",
        criteria: [],
        expectedOutputs: [],
      } as never);
  });
  afterEach(() => findFirstSpy.mockRestore());

  it("POST with someone else's room: the service's refusal is a 404", async () => {
    const res = await send("POST", "/focus-sessions", {
      userId: USER_ID,
      projectId: "p-1",
      goal: "Do it",
      channelId: THEIR_ROOM,
    });
    expect(res.status).toBe(404);
    // ONE door: the route no longer asks the floor itself — the service does.
    expect(h.seeCalls).toEqual([]);
    expect(h.created[0]).toMatchObject({
      userId: USER_ID,
      channelId: THEIR_ROOM,
    });
  });

  it("POST with the caller's own room reaches the service with it", async () => {
    const res = await send("POST", "/focus-sessions", {
      userId: USER_ID,
      projectId: "p-1",
      goal: "Do it",
      channelId: MY_ROOM,
    });
    expect(res.status).toBe(200);
    expect(h.created[0]).toMatchObject({ channelId: MY_ROOM });
  });

  it("PATCH to someone else's room: 404 before the membrane", async () => {
    const res = await send("PATCH", `/focus-sessions/${SESSION_ID}`, {
      channelId: THEIR_ROOM,
    });
    expect(res.status).toBe(404);
    expect(h.seeCalls).toEqual([[THEIR_ROOM, USER_ID]]);
    expect(h.gated).toHaveLength(0);
  });

  it("PATCH to the caller's own room passes the floor (reaches the membrane)", async () => {
    await send("PATCH", `/focus-sessions/${SESSION_ID}`, {
      channelId: MY_ROOM,
    });
    expect(h.gated[0]?.data).toMatchObject({ channelId: MY_ROOM });
  });
});
