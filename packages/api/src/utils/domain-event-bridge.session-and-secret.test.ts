/**
 * domain-event-bridge — two wire contracts the realtime security lane fixed:
 *
 *  - `focus_session.*` is NOT bridged: `focus_session:updated` has ONE
 *    producer, the DB-trigger listener (`session-changed-listener.ts`, whose
 *    pglite test owns the id-only / owner + roster contract).
 *  - Every bridge POST carries `X-Bridge-Secret` when `BRIDGE_SECRET` is set —
 *    `bridgeSecretOk` 401s it otherwise, and the old fetch sent no header.
 *
 * The DB is a fake that WOULD return a session row, so a regression that
 * re-routes focus_session events through the bridge has an audience to post to.
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

describe("focus_session.* — NOT bridged (one producer)", () => {
  it("a focus_session event through the bridge posts nothing", async () => {
    rows.session = [{ userId: "owner_1", channelId: null }];
    // The live push is the 0277 row trigger → session-changed-listener.ts; a
    // bridge emit here would be a second producer (and a double push).
    emitHubRealtimeEvent({
      eventType: "focus_session.update.completed",
      subjectId: "sess_1",
      userId: "owner_1",
      data: { id: "sess_1", workspaceId: "ws_1", goal: "SECRET GOAL" },
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
