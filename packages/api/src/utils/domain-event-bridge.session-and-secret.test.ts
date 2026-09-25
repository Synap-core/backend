/**
 * domain-event-bridge — two wire contracts the realtime security lane fixed:
 *
 *  - `focus_session:updated` is ID-ONLY and goes to the `user:` rooms of the
 *    session's owner + its room's human roster — never `workspace:<id>` (every
 *    member's socket) and never the goal. The emitter passes the goal in
 *    `data` (four call sites do); the bridge must not forward it.
 *  - Every bridge POST carries `X-Bridge-Secret` when `BRIDGE_SECRET` is set —
 *    `bridgeSecretOk` 401s it otherwise, and the old fetch sent no header.
 *
 * The DB is a fake returning the session row / roster rows; the audience QUERY
 * shape is not exercised here (the owner + roster lookup is two plain selects).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rows = vi.hoisted(() => ({
  session: [] as Array<{ userId: string; channelId: string | null }>,
  roster: [] as Array<{ memberId: string }>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = {
    select: () => ({
      from: () => ({
        // session lookup: select().from().where().limit()
        where: () => ({ limit: async () => rows.session }),
        // roster lookup: select().from().innerJoin().where()
        innerJoin: () => ({ where: async () => rows.roster }),
      }),
    }),
  };
  return { ...actual, db };
});

import type { EventRecord } from "@synap/database";
import {
  emitDomainEventToRealtime,
  emitHubRealtimeEvent,
} from "./domain-event-bridge.js";

type Call = [string, { headers: Record<string, string>; body: string }];
let fetchMock: ReturnType<typeof vi.fn>;
const bodies = () =>
  (fetchMock.mock.calls as Call[]).map((c) => JSON.parse(c[1].body));

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  vi.stubGlobal("fetch", fetchMock);
  rows.session = [];
  rows.roster = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.BRIDGE_SECRET;
});

describe("focus_session:updated — id-only, owner + roster user rooms", () => {
  it("never targets the workspace room and never carries the goal", async () => {
    rows.session = [{ userId: "owner_1", channelId: "room_1" }];
    rows.roster = [{ memberId: "owner_1" }, { memberId: "roster_2" }];

    // The shape the proposal executor emits: approver ≠ owner, goal in data.
    emitHubRealtimeEvent({
      eventType: "focus_session.update.completed",
      subjectId: "sess_1",
      userId: "approver_9",
      data: {
        id: "sess_1",
        workspaceId: "ws_1",
        goal: "SECRET GOAL",
        progress: 3,
      },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const sent = bodies();
    expect(sent.map((b) => b.event)).toEqual([
      "focus_session:updated",
      "focus_session:updated",
    ]);
    expect(sent.map((b) => b.userId).sort()).toEqual(["owner_1", "roster_2"]);
    for (const b of sent) {
      expect(b.workspaceId).toBeUndefined();
      expect(b.data).toEqual({ id: "sess_1", sessionId: "sess_1" });
    }
    expect(JSON.stringify(sent)).not.toContain("SECRET GOAL");
  });

  it("a pod-scoped (NULL-workspace) session still pushes to its owner", async () => {
    rows.session = [{ userId: "owner_1", channelId: null }];
    emitHubRealtimeEvent({
      eventType: "focus_session.create.completed",
      subjectId: "sess_2",
      userId: "owner_1",
      data: { id: "sess_2", workspaceId: null },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(bodies()[0]).toMatchObject({
      event: "focus_session:updated",
      userId: "owner_1",
    });
  });

  it("an unknown session pushes nothing", async () => {
    emitHubRealtimeEvent({
      eventType: "focus_session.update.completed",
      subjectId: "gone",
      userId: "u",
      data: {},
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bridge secret", () => {
  it("sends X-Bridge-Secret when BRIDGE_SECRET is set", async () => {
    process.env.BRIDGE_SECRET = "s3cret";
    emitDomainEventToRealtime({
      id: "e",
      timestamp: new Date(),
      subjectId: "ent_1",
      subjectType: "entity",
      eventType: "entity.update.completed",
      userId: "u",
      data: { workspaceId: "ws_1" },
      version: 1,
      source: "api",
    } as EventRecord);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as Call;
    expect(init.headers["X-Bridge-Secret"]).toBe("s3cret");
  });

  it("sends no secret header when BRIDGE_SECRET is unset (local dev)", async () => {
    emitDomainEventToRealtime({
      id: "e",
      timestamp: new Date(),
      subjectId: "ent_1",
      subjectType: "entity",
      eventType: "entity.update.completed",
      userId: "u",
      data: { workspaceId: "ws_1" },
      version: 1,
      source: "api",
    } as EventRecord);
    await Promise.resolve();
    const [, init] = fetchMock.mock.calls[0] as Call;
    expect(init.headers["X-Bridge-Secret"]).toBeUndefined();
  });
});
