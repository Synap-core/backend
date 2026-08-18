/**
 * Tests for the domain-event → Socket.IO bridge: facet event mapping (role-as-lens
 * visibility grants) and the unified room rule (workspace room when the event's
 * row carries a workspaceId, else the owner's user room).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventRecord } from "@synap/database";
import { emitDomainEventToRealtime } from "./domain-event-bridge.js";

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

  it("pod-wide entity (null/absent workspaceId) falls back to the owner's user room", async () => {
    // Pod-wide bridge model: a NULL-workspace entity is no longer DROPPED — it
    // publishes to `user:<ownerUserId>` via the unified room rule (was the
    // "pod-wide = no realtime" gap). Workspace-scoped entities still route to
    // the workspace room (next test).
    emitDomainEventToRealtime(
      makeEvent({
        eventType: "entity.create.completed",
        userId: "user_1",
        data: {},
      })
    );
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.event).toBe("entity:created");
    expect(body.workspaceId).toBeUndefined();
    expect(body.userId).toBe("user_1");
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
