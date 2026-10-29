/**
 * A status move reaches clients as ONE `entity:updated` (status-flow W7).
 *
 * The status door's one event is `entity.transition.completed`; its log row is
 * appended through the hooked `eventRepository` (`lifecycle-transition.ts`,
 * pinned in its own test), and this bridge turns it into the socket event
 * clients listen for. The payload is checked against the realtime server's
 * OWN schema lookup, the one `/bridge/emit` refuses a payload with (400).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventRecord } from "@synap/database";
import { getSchemaForEvent } from "@synap/events/realtime-schemas";
import { emitDomainEventToRealtime } from "./domain-event-bridge.js";

/** The log row `emitLifecycleTransition` appends for a kind's move. */
function transitionRow(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "t1",
    timestamp: new Date("2026-10-29T10:00:00Z"),
    subjectId: "e1",
    subjectType: "entity",
    eventType: "entity.transition.completed",
    userId: "u1",
    data: {
      transitionId: "t1",
      subjectType: "entity",
      subjectId: "e1",
      entityId: "e1",
      profileSlug: "deal",
      role: null,
      facetId: null,
      property: "commercialStage",
      from: "draft",
      to: "negotiating",
      fromCategory: "open",
      category: "active",
      actorKind: "agent",
      userId: "u1",
      agentUserId: "a1",
      sessionId: null,
      reason: null,
      staleExpected: false,
      proposalId: null,
      workspaceId: "w1",
      lifecycleProfile: "deal",
    },
    version: 1,
    source: "api",
    ...overrides,
  } as EventRecord;
}

describe("domain-event-bridge — a status move", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bodies = () =>
    fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));

  it("an entity's transition is pushed ONCE as entity:updated, to its workspace room", async () => {
    emitDomainEventToRealtime(transitionRow());
    await Promise.resolve();

    expect(bodies()).toHaveLength(1);
    const [body] = bodies();
    expect(body.event).toBe("entity:updated");
    expect(body.workspaceId).toBe("w1");
    expect(body.data).toMatchObject({
      entityId: "e1",
      changes: { commercialStage: "negotiating" },
      updatedBy: "a1",
      updatedAt: "2026-10-29T10:00:00.000Z",
    });
  });

  it("the payload passes the realtime server's own entity:updated schema", async () => {
    emitDomainEventToRealtime(transitionRow());
    emitDomainEventToRealtime(
      transitionRow({
        data: {
          ...transitionRow().data,
          role: "client",
          agentUserId: null,
        },
      })
    );
    await Promise.resolve();

    const schema = getSchemaForEvent("entity:updated");
    expect(schema).toBeDefined();
    for (const body of bodies()) {
      expect(schema!.safeParse(body.data).success).toBe(true);
    }
    // A person's move names the person.
    expect(bodies()[1].data.updatedBy).toBe("u1");
  });

  it("a goal's or a session's transition is not bridged (no client listens)", async () => {
    for (const subjectType of ["track", "focus_session"]) {
      emitDomainEventToRealtime(
        transitionRow({
          subjectType,
          eventType: `${subjectType}.transition.completed`,
        })
      );
    }
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
