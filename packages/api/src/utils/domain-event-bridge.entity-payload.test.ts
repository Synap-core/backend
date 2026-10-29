/**
 * Every `entity:*` push passes the realtime server's validation.
 *
 * A repository emit carries the entity ROW (`base-repository.ts`
 * `emitCompleted`): no `entityId`, no actor, no `changes`. The realtime
 * server's `/bridge/emit` answers 400 to such a payload (`validateEmitPayload`,
 * the function driven here), so before the bridge projected it no
 * repository `entity:*` push reached a client. One test per event type, plus
 * the media copy's announcement and the pod-wide case pinned as it is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventRecord } from "@synap/database";
import { validateEmitPayload } from "@synap/events/realtime-schemas";
import {
  emitDomainEventToRealtime,
  emitHubRealtimeEvent,
} from "./domain-event-bridge.js";

/** An entity row as `EntityRepository` emits it (JSON: timestamps are strings). */
const ROW = {
  id: "e1",
  userId: "u1",
  workspaceId: "w1",
  homeWorkspaceId: null,
  profileId: "p1",
  type: "task",
  title: "Write the brief",
  preview: "First draft",
  documentId: null,
  properties: { priority: "high", taskStatus: "doing" },
  status: "doing",
  statusCategory: "active",
  systemData: {},
  version: 3,
  createdAt: "2026-10-28T09:00:00.000Z",
  updatedAt: "2026-10-29T10:00:00.000Z",
  deletedAt: null,
};

function row(
  eventType: string,
  data: Record<string, unknown>,
  overrides: Partial<EventRecord> = {}
): EventRecord {
  return {
    id: "evt-1",
    timestamp: new Date("2026-10-29T10:00:00Z"),
    subjectId: "e1",
    subjectType: "entity",
    eventType,
    userId: "u1",
    data,
    version: 1,
    source: "api",
    ...overrides,
  } as EventRecord;
}

describe("domain-event-bridge — entity payloads pass the realtime validation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const pushed = () =>
    fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));
  const one = async (record: EventRecord) => {
    emitDomainEventToRealtime(record);
    await Promise.resolve();
    expect(pushed()).toHaveLength(1);
    return pushed()[0];
  };

  it("entity.create.completed (the repository row) → a valid entity:created", async () => {
    const body = await one(row("entity.create.completed", ROW));
    expect(body.event).toBe("entity:created");
    expect(validateEmitPayload(body.event, body.data)).toEqual({ ok: true });
    expect(body.data).toMatchObject({
      entityId: "e1",
      type: "task",
      title: "Write the brief",
      createdBy: "u1",
      createdAt: "2026-10-29T10:00:00.000Z",
    });
  });

  it("an untitled entity's create is still valid", async () => {
    const body = await one(
      row("entity.create.completed", { ...ROW, title: null })
    );
    expect(validateEmitPayload(body.event, body.data)).toEqual({ ok: true });
  });

  it("entity.update.completed (the repository row) → a valid entity:updated whose changes patch the top level as the API returns it", async () => {
    const body = await one(row("entity.update.completed", ROW));
    expect(body.event).toBe("entity:updated");
    expect(validateEmitPayload(body.event, body.data)).toEqual({ ok: true });
    expect(body.data).toMatchObject({ entityId: "e1", updatedBy: "u1" });
    expect(body.data.changes).toEqual({
      title: "Write the brief",
      preview: "First draft",
      documentId: null,
      properties: { priority: "high", taskStatus: "doing" },
      systemData: {},
      status: "doing",
      statusCategory: "active",
    });
    // Never the timestamps (the client sets updatedAt itself, as a Date) nor
    // identity columns: `changes` is spread onto the cached entity.
    for (const key of ["createdAt", "updatedAt", "id", "userId", "version"]) {
      expect(body.data.changes).not.toHaveProperty(key);
    }
  });

  it("an update with no whole row patches nothing (and stays valid)", async () => {
    const body = await one(
      row("entity.update.completed", { workspaceId: "w1" })
    );
    expect(validateEmitPayload(body.event, body.data)).toEqual({ ok: true });
    expect(body.data.changes).toEqual({});
  });

  it("entity.delete.completed (id, workspaceId, type) → a valid entity:deleted", async () => {
    const body = await one(
      row("entity.delete.completed", {
        id: "e1",
        workspaceId: "w1",
        type: "task",
      })
    );
    expect(body.event).toBe("entity:deleted");
    expect(validateEmitPayload(body.event, body.data)).toEqual({ ok: true });
    expect(body.data).toMatchObject({ entityId: "e1", deletedBy: "u1" });
  });

  it("the media copy's announcement (copy-entity-media.ts) is valid and keeps its reason", async () => {
    // The shape `announceMediaCopied` sends through `emitHubRealtimeEvent`.
    emitHubRealtimeEvent({
      eventType: "entity.update.completed",
      subjectId: "e1",
      userId: "u1",
      data: { entityId: "e1", reason: "media", workspaceId: "w1" },
    });
    await Promise.resolve();
    const [body] = pushed();
    expect(validateEmitPayload(body.event, body.data)).toEqual({ ok: true });
    expect(body.data).toMatchObject({ reason: "media", changes: {} });
  });

  // PINNED AS IT IS (not a target): the unified room rule sends a pod-wide
  // entity to its owner's room, and the schema refuses a null workspace.
  it("a pod-wide entity (workspaceId null) goes to the owner's room and is refused", async () => {
    for (const type of [
      "entity.create.completed",
      "entity.update.completed",
      "entity.delete.completed",
    ]) {
      emitDomainEventToRealtime(row(type, { ...ROW, workspaceId: null }));
    }
    await Promise.resolve();
    expect(pushed()).toHaveLength(3);
    for (const body of pushed()) {
      expect(body.workspaceId).toBeUndefined();
      expect(body.userId).toBe("u1");
      expect(validateEmitPayload(body.event, body.data).ok).toBe(false);
    }
  });
});
