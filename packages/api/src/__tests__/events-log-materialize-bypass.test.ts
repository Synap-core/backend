/**
 * SECURITY REGRESSION — `trpc.events.log` must not accept a lifecycle phase.
 *
 * HISTORY: this file began as a probe that PROVED a reachable RCE. `events.log`
 * accepted an ARBITRARY `eventType`, and `setup-event-broadcasting`'s
 * materialization hook fires on ANY type ending `.validated`, forwarding a
 * CALLER-SUPPLIED `data.workspaceId` and a caller-parsed `<subjectType>.<action>`
 * into the pg-boss "materialize" queue. The worker then ran
 * `execFileSync("/bin/sh", ["-c", data.command])` on the pod host.
 *
 * DEFENCE IS IN TWO INDEPENDENT LAYERS, and this file guards the first:
 *   1. HERE — the door rejects any client-asserted lifecycle phase, so a
 *      `.validated` event can no longer be appended by a caller at all.
 *   2. `handleMaterialize` — refuses any job without an APPROVED proposal, and
 *      derives workspaceId from the proposal row. Guarded by
 *      `packages/jobs/src/workers/__tests__/materialize-command-no-proposal-check.test.ts`.
 *
 * The hook is deliberately NOT the gate: narrowing it to known command types
 * would still forward a caller-supplied workspaceId and still trust an
 * unverified approval. The tests below therefore keep asserting that the hook
 * remains permissive — that is by design, and layer 2 is what makes it safe.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { eventsRouter } from "../routers/events.js";
import { createSynapEvent } from "@synap-core/core";
import { eventRepository, type EventHook } from "@synap/database";

const sent: Array<{ queue: string; payload: any }> = [];

vi.mock("@synap/jobs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getBoss: () => ({
      send: async (queue: string, payload: any) => {
        sent.push({ queue, payload });
        return "job-id";
      },
    }),
  };
});

/** The forged payload an authenticated pod user would POST to /trpc. */
const FORGED = {
  subjectId: "11111111-1111-4111-8111-111111111111",
  subjectType: "system" as const,
  eventType: "command.execute.validated",
  data: {
    workspaceId: "22222222-2222-4222-8222-222222222222",
    command: "id > /tmp/synap-bypass-probe",
  },
  version: 1,
};

const inputSchema = () =>
  (eventsRouter as any)._def.procedures.log._def.inputs[0];

describe("events.log — reserved lifecycle phases are rejected", () => {
  it("REJECTS a client-asserted .validated eventType (the original RCE entry point)", () => {
    const result = inputSchema().safeParse(FORGED);
    expect(
      result.success,
      "SECURITY REGRESSION: the door accepted a .validated eventType"
    ).toBe(false);
  });

  it.each([".validated", ".completed", ".failed"])(
    "REJECTS the reserved phase %s",
    (phase) => {
      const result = inputSchema().safeParse({
        ...FORGED,
        eventType: `entity.create${phase}`,
      });
      expect(result.success).toBe(false);
    }
  );

  it("still ACCEPTS a legitimate intent event (.requested)", () => {
    const result = inputSchema().safeParse({
      ...FORGED,
      eventType: "note.creation.requested",
    });
    expect(
      result.success,
      "the fix must not break legitimate intent logging"
    ).toBe(true);
  });

  it("still ACCEPTS a plain domain event with no lifecycle phase", () => {
    const result = inputSchema().safeParse({
      ...FORGED,
      eventType: "task.archived",
    });
    expect(result.success).toBe(true);
  });
});

describe("the layers behind the door (documented, not the gate)", () => {
  let hooks: EventHook[];

  beforeAll(async () => {
    hooks = [];
    vi.spyOn(eventRepository, "addEventHook").mockImplementation(((
      h: EventHook
    ) => {
      hooks.push(h);
    }) as never);

    const { setupEventBroadcasting } =
      await import("../setup-event-broadcasting.js");
    setupEventBroadcasting();
  });

  it("createSynapEvent does NOT constrain the event type (why the door must)", () => {
    const event = createSynapEvent({
      type: FORGED.eventType,
      userId: "attacker-user",
      subjectId: FORGED.subjectId,
      data: FORGED.data,
      source: "api",
    });
    expect(event.type).toBe("command.execute.validated");
  });

  it("the hook still forwards a caller-supplied workspaceId — which is why handleMaterialize re-derives it from the proposal", async () => {
    expect(hooks.length).toBeGreaterThan(0);

    const eventRecord = {
      id: "33333333-3333-4333-8333-333333333333",
      eventType: FORGED.eventType,
      subjectId: FORGED.subjectId,
      subjectType: "system",
      userId: "attacker-user",
      data: FORGED.data,
      correlationId: "44444444-4444-4444-8444-444444444444",
    };

    for (const h of hooks) {
      try {
        await h(eventRecord as never);
      } catch {
        // Other hooks (SSE/realtime/sync) may need infra; irrelevant here.
      }
    }

    const materialize = sent.find((s) => s.queue === "materialize");
    expect(materialize).toBeDefined();
    // Documents the residual trust in the payload. Safe ONLY because
    // handleMaterialize ignores these fields in favour of the proposal row.
    expect(materialize!.payload).toMatchObject({
      subjectType: "command",
      workspaceId: "22222222-2222-4222-8222-222222222222",
    });
  });
});
