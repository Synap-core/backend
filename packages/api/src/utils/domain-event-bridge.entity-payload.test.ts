/**
 * Every `entity:*` push passes the realtime server's validation.
 *
 * A repository emit carries the entity ROW (`base-repository.ts`
 * `emitCompleted`): no `entityId`, no actor, no `changes`. The realtime
 * server's `/bridge/emit` answers 400 to such a payload (`validateEmitPayload`,
 * the function driven here), so before the bridge projected it no
 * repository `entity:*` push reached a client. One test per event type, plus
 * the media copy's announcement, and the pod-wide case: refused by the schema,
 * so not sent at all.
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
      // The row's own time, and its counter at the top level.
      createdAt: "2026-10-28T09:00:00.000Z",
      version: 3,
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
    expect(body.data).toMatchObject({
      entityId: "e1",
      updatedBy: "u1",
      updatedAt: "2026-10-29T10:00:00.000Z",
      version: 3,
    });
    expect(body.data.changes).toEqual({
      // An update can change the kind and the space: they travel too.
      type: "task",
      profileSlug: "task",
      profileId: "p1",
      workspaceId: "w1",
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

  it("an AGENT's write names the agent as the actor", async () => {
    const body = await one(
      row("entity.update.completed", ROW, { agentUserId: "agent-7" })
    );
    expect(body.data.updatedBy).toBe("agent-7");
    expect(validateEmitPayload(body.event, body.data)).toEqual({ ok: true });
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

  // A pod-wide entity's payload is refused by the realtime schema (it needs a
  // workspace), so it is not POSTed at all — no refused request, no warning.
  it("a pod-wide entity (workspaceId null) fails the schema, so nothing is sent", async () => {
    for (const type of [
      "entity.create.completed",
      "entity.update.completed",
      "entity.delete.completed",
    ]) {
      emitDomainEventToRealtime(row(type, { ...ROW, workspaceId: null }));
    }
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
    // The reason, pinned: the same projection with a workspace passes.
    emitDomainEventToRealtime(row("entity.update.completed", ROW));
    await Promise.resolve();
    expect(pushed()).toHaveLength(1);
  });
});
