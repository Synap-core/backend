/**
 * Tests for the domain-event → Socket.IO bridge: facet event mapping (role-as-lens
 * visibility grants) and the unified room rule (workspace room when the event's
 * row carries a workspaceId; else, for an entity, each reader's user room, and
 * for anything else the writer's user room).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventRecord } from "@synap/database";
import { emitDomainEventToRealtime } from "./domain-event-bridge.js";

// A pod-wide entity's readers come from the entity read floor (DB):
// pinned on real SQL in domain-event-bridge.pod-wide.pglite.test.ts.
const audience = vi.hoisted(() => ({
  readers: ["user_1", "reader_2"] as string[],
  fail: false,
}));
vi.mock("../services/status/status-floor.js", () => ({
  entityAudience: vi.fn(async () => {
    if (audience.fail) throw new Error("floor read failed");
    return audience.readers;
  }),
}));

function makeEvent(overrides: Partial<EventRecord>): EventRecord {
  return {
    id: "evt_1",
    timestamp: new Date(),
    subjectId: "facet_1",
    subjectType: "entity_facet",
    eventType: "entity_facet.create.completed",
    userId: "user_1",
    data: {},
    version: 1,
    source: "api",
    ...overrides,
  } as EventRecord;
}

describe("domain-event-bridge — facet events", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps entity_facet.create/update/delete.completed to socket event names", async () => {
    emitDomainEventToRealtime(
      makeEvent({
        eventType: "entity_facet.create.completed",
        data: { entityId: "ent_1", workspaceId: "ws_1" },
      })
    );
    emitDomainEventToRealtime(
      makeEvent({
        eventType: "entity_facet.update.completed",
        data: { entityId: "ent_1", workspaceId: "ws_1" },
      })
    );
    emitDomainEventToRealtime(
      makeEvent({
        eventType: "entity_facet.delete.completed",
        data: { id: "facet_1" },
      })
    );

    // fetch is fire-and-forget; give the microtask queue a tick.
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const events = fetchMock.mock.calls.map(
      (call) => JSON.parse(call[1].body as string).event
    );
    expect(events).toEqual([
      "entity_facet:attached",
      "entity_facet:updated",
      "entity_facet:detached",
    ]);
  });

  it("targets the workspace room when the event carries a workspaceId", async () => {
    emitDomainEventToRealtime(
      makeEvent({
        eventType: "entity_facet.create.completed",
        userId: "user_1",
        data: { entityId: "ent_1", workspaceId: "ws_1" },
      })
    );
    await Promise.resolve();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.workspaceId).toBe("ws_1");
    expect(body.userId).toBeUndefined();
  });

  it("falls back to the owner's user room for a pod-wide (null workspaceId) facet", async () => {
    emitDomainEventToRealtime(
      makeEvent({
        eventType: "entity_facet.create.completed",
        userId: "user_1",
        data: { entityId: "ent_1", workspaceId: null },
      })
    );
    await Promise.resolve();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.workspaceId).toBeUndefined();
    expect(body.userId).toBe("user_1");
  });

  it("pod-wide entity (null/absent workspaceId): one POST per reader, writer included, never a workspace room", async () => {
    await emitDomainEventToRealtime(
      makeEvent({
        eventType: "entity.create.completed",
        subjectId: "ent_1",
        subjectType: "entity",
        userId: "user_1",
        // No workspace key at all (absent, not null).
        data: { type: "task" },
      })
    );

    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse(call[1].body as string)
    );
    // The writer is a reader too: once each, never twice.
    expect(bodies.map((b) => b.userId).sort()).toEqual(["reader_2", "user_1"]);
    for (const b of bodies) {
      expect(b.event).toBe("entity:created");
      expect(b.workspaceId).toBeUndefined();
      expect(b.data.entityId).toBe("ent_1");
    }
  });

  it("pod-wide entity whose readers cannot be read: the writer only, never everyone", async () => {
    audience.fail = true;
    try {
      await emitDomainEventToRealtime(
        makeEvent({
          eventType: "entity.update.completed",
          subjectId: "ent_1",
          subjectType: "entity",
          userId: "user_1",
          data: { workspaceId: null },
        })
      );
    } finally {
      audience.fail = false;
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).userId).toBe(
      "user_1"
    );
  });

  it("workspace-scoped entity still targets the workspace room (unaffected)", async () => {
    emitDomainEventToRealtime(
      makeEvent({
        eventType: "entity.update.completed",
        userId: "user_1",
        data: { workspaceId: "ws_1" },
      })
    );
    await Promise.resolve();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.workspaceId).toBe("ws_1");
    expect(body.userId).toBeUndefined();
  });

  it("broadcasts workspace updates in the cache envelope without settings secrets", async () => {
    emitDomainEventToRealtime(
      makeEvent({
        subjectId: "ws_1",
        subjectType: "workspaces",
        eventType: "workspaces.update.completed",
        data: {
          id: "ws_1",
          workspace: {
            id: "ws_1",
            name: "CRM",
            settings: {
              layout: {
                primarySurface: {
                  kind: "app",
                  appId: "crm",
                  rendererType: "external",
                  url: "https://crm.synap.live",
                },
              },
              nango: { secretKey: "nango-secret" },
              mcpServers: [{ env: { API_KEY: "mcp-secret" } }],
            },
          },
        },
      })
    );
    await Promise.resolve();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.workspaceId).toBe("ws_1");
    expect(body.data.workspace).toEqual(
      expect.objectContaining({
        id: "ws_1",
        name: "CRM",
        settings: {
          layout: expect.objectContaining({
            primarySurface: expect.objectContaining({ appId: "crm" }),
          }),
        },
      })
    );
    expect(body.data.id).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("nango-secret");
    expect(JSON.stringify(body)).not.toContain("mcp-secret");
  });
});
