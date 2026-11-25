import { describe, expect, it } from "vitest";
import {
  askCardHandlers,
  askCardReceipt,
  askEmbedRead,
  type AskCardEvent,
  type AskReceipt,
} from "./ask-embed-model";
import { answerCall } from "../../../(admin)/review/_lib/ask-detail";

// The read rules (slot resolution, states, receipt, copy) are tested where they
// live: `packages/types/src/ask/embed.test.ts`. This file covers what pod admin
// adds: the console's `AskSlot` and the React handlers.

const SESSION = "6f1c2c1e-0000-4000-8000-000000000001";
const CONFIRM = { mode: "confirm", prompt: "Ship it today?" } as const;

const owed = (over: Record<string, unknown> = {}) => ({
  kind: "decision",
  label: "Ship it?",
  key: "ship-it",
  owner: "human",
  status: "pending",
  owedSince: "2026-11-16T09:00:00.000Z",
  ask: CONFIRM,
  ...over,
});

const read = (
  expectedOutputs: unknown[],
  over: Record<string, unknown> = {},
  slot = "ship-it"
) =>
  askEmbedRead(
    {
      isLoading: false,
      error: null,
      data: {
        title: "Launch",
        status: "active",
        viewerRole: "owner",
        expectedOutputs,
        ...over,
      },
      dataUpdatedAt: 100,
    },
    { sessionId: SESSION, slot }
  );

describe("askEmbedRead — pod admin's AskSlot over the shared read", () => {
  it("an owed slot is open: the console's AskSlot, who may answer, the work it comes from", () => {
    expect(read([owed()])).toMatchObject({
      state: "open",
      canAnswer: true,
      readAt: 100,
      slot: {
        sessionId: SESSION,
        label: "Ship it?",
        slotKey: "ship-it",
        ask: CONFIRM,
      },
      session: { id: SESSION, title: "Launch", status: "active" },
    });
    expect(read([owed()], { viewerRole: "member" })).toMatchObject({
      state: "open",
      canAnswer: false,
    });
  });

  it("the asker is named from the session's participants, by the slot's askedBy", () => {
    expect(
      read([owed({ askedBy: "agent-1" })], {
        participants: [{ id: "agent-1", name: "Claude-code" }],
      })
    ).toMatchObject({
      state: "open",
      slot: { askerName: "Claude-code", askerId: "agent-1" },
    });
  });

  it("the answer is sent with the MATCHED slot's key, not the shared label", () => {
    const slots = [
      owed({ key: "ship-it", owner: "agent", answer: { text: "old" } }),
      owed({ key: "ship-it-2" }),
    ];
    const r = read(slots, {}, "Ship it?");
    if (r.state !== "open") throw new Error("expected open");
    const built = answerCall(r.slot, {
      type: "confirm",
      confirmed: true,
      note: "",
    });
    expect(built.ok && built.call.expectedLabel).toBe("ship-it-2");
  });

  it("a non-open state passes through unchanged", () => {
    expect(read([owed({ owner: "agent" })]).state).toBe("closed");
    expect(read([owed()], {}, "nope").state).toBe("hidden");
  });
});

describe("askCardHandlers — only a settle makes the receipt", () => {
  const settle = (events: AskCardEvent[]) =>
    events.reduce(askCardReceipt, null as AskReceipt | null);

  it.each(["answered", "attested", "handed-back", "refused"] as const)(
    "a %s settle sets a receipt of that kind",
    (kind) => {
      const events: AskCardEvent[] = [];
      askCardHandlers((e) => events.push(e)).onSettled(kind);
      expect(settle(events)).toMatchObject({ kind });
    }
  );

  it("a refusal that moved on leaves it unset", () => {
    const events: AskCardEvent[] = [];
    askCardHandlers((e) => events.push(e)).onClose();
    expect(events).toEqual([{ type: "moved-on" }]);
    expect(settle(events)).toBeNull();
  });
});
