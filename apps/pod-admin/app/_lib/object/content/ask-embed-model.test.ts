import { describe, expect, it } from "vitest";
import { catalogProblems } from "@synap-core/types/i18n";
import {
  askCardHandlers,
  askCardReceipt,
  askEmbedRead,
  findAskSlot,
  receiptStands,
  type AskCardEvent,
  type AskReceipt,
} from "./ask-embed-model";
import { answerCall } from "../../../(admin)/review/_lib/ask-detail";
import { en, fr } from "./ask-embed-copy";
import type { EmbedAskRead } from "./ask-embed-model";

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

describe("findAskSlot — the answer door's rule: key first, then trimmed + casefolded label", () => {
  it("by stored key, by label, by casefolded label, by a key derived for a keyless slot", () => {
    const slots = [owed(), { kind: "decision", label: "Pick a logo" }];
    expect(findAskSlot(slots, "ship-it")).toMatchObject({
      slot: slots[0],
      key: "ship-it",
    });
    expect(findAskSlot(slots, "Ship it?")).toMatchObject({ key: "ship-it" });
    expect(findAskSlot(slots, "  ship IT?  ")).toMatchObject({
      key: "ship-it",
    });
    expect(findAskSlot(slots, "pick-a-logo")).toMatchObject({
      slot: slots[1],
      key: "pick-a-logo",
    });
    expect(findAskSlot(slots, "nope")).toBeNull();
    expect(findAskSlot(slots, " ")).toBeNull();
    expect(findAskSlot("not a list", "x")).toBeNull();
  });

  it("a key equal to ANOTHER slot's label names the key's slot (key rung first)", () => {
    const slots = [
      { label: "second", key: "first" },
      { label: "first", key: "second" },
    ];
    const hit = findAskSlot(slots, "first");
    expect(hit).toMatchObject({ slot: slots[0], key: "first" });
  });

  it("duplicate labels: the OWED one is chosen, with its own key", () => {
    const slots = [
      owed({ key: "ship-it", owner: "agent", answer: { text: "old" } }),
      owed({ key: "ship-it-2" }),
    ];
    expect(findAskSlot(slots, "Ship it?")).toMatchObject({
      slot: slots[1],
      key: "ship-it-2",
    });
  });

  it("duplicate labels with no single owed slot are ambiguous, never a guess", () => {
    const answered = (key: string) =>
      owed({ key, owner: "agent", answer: { text: "a" } });
    expect(findAskSlot([answered("a"), answered("b")], "Ship it?")).toBe(
      "ambiguous"
    );
    expect(
      findAskSlot([owed({ key: "a" }), owed({ key: "b" })], "Ship it?")
    ).toBe("ambiguous");
    // …but the key still names exactly one.
    expect(
      findAskSlot([owed({ key: "a" }), owed({ key: "b" })], "b")
    ).toMatchObject({
      key: "b",
    });
  });
});

describe("askEmbedRead — each state is its own fact", () => {
  it("loading is loading", () => {
    expect(
      askEmbedRead(
        { isLoading: true, error: null, data: undefined },
        { sessionId: SESSION, slot: "x" }
      )
    ).toEqual({ state: "loading" });
  });

  it("a FAILED read is failed (retryable), never hidden, never empty", () => {
    const retry = () => {};
    const r = askEmbedRead(
      {
        isLoading: false,
        isFetching: true,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
        data: undefined,
        retry,
      },
      { sessionId: SESSION, slot: "x" }
    );
    expect(r).toEqual({ state: "failed", retry, retrying: true });
  });

  it("an answer with no readable shape is a failed read, not an empty session", () => {
    const r = askEmbedRead(
      { isLoading: false, error: null, data: undefined },
      { sessionId: SESSION, slot: "x" }
    );
    expect(r).toMatchObject({ state: "failed", retrying: false });
  });

  it("an expired sign-in (UNAUTHORIZED) is a failed read, never 'not available'", () => {
    const r = askEmbedRead(
      {
        isLoading: false,
        error: { data: { code: "UNAUTHORIZED" } },
        data: undefined,
      },
      { sessionId: SESSION, slot: "x" }
    );
    expect(r.state).toBe("failed");
  });

  it("NOT_FOUND / FORBIDDEN, an unknown slot and an ambiguous one are hidden", () => {
    for (const code of ["NOT_FOUND", "FORBIDDEN"]) {
      expect(
        askEmbedRead(
          { isLoading: false, error: { data: { code } }, data: undefined },
          { sessionId: SESSION, slot: "x" }
        ).state
      ).toBe("hidden");
    }
    expect(read([owed()], {}, "no-such-slot").state).toBe("hidden");
    expect(
      read([owed({ key: "a" }), owed({ key: "b" })], {}, "Ship it?").state
    ).toBe("hidden");
  });

  it("an owed slot is open: the shared AskSlot, who may answer, the work it comes from", () => {
    const r = read([owed()], {
      participants: [{ id: "agent-1", name: "Claude-code" }],
    });
    expect(r).toMatchObject({
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
    const r = read([owed({ askedBy: "agent-1" })], {
      participants: [{ id: "agent-1", name: "Claude-code" }],
    });
    expect(r).toMatchObject({
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

  it("an answered slot carries the recorded answer, no slot to answer", () => {
    expect(
      read([owed({ owner: "agent", answer: { text: "Yes, ship it" } })])
    ).toEqual({ state: "answered", answer: "Yes, ship it", attested: false });
    // Re-asked: owner is human again with the old answer still on it. Owed.
    expect(read([owed({ answer: { text: "Old answer" } })]).state).toBe("open");
  });

  it("an attested slot reads attested", () => {
    expect(
      read([owed({ attestedAt: "2026-11-16T10:00:00.000Z", status: "done" })])
    ).toEqual({ state: "answered", answer: null, attested: true });
  });

  it("a retired slot, or a closed one with no answer, is closed", () => {
    expect(read([owed({ retiredAt: "2026-11-16T10:00:00.000Z" })]).state).toBe(
      "closed"
    );
    expect(read([owed({ owner: "agent" })]).state).toBe("closed");
  });

  it("a hand-over (provide: secret, connection, file) is never answered inline", () => {
    for (const provide of [
      { kind: "secret", name: "STRIPE_KEY" },
      { kind: "connection", service: "github" },
      { kind: "file" },
    ]) {
      expect(read([owed({ ask: { mode: "provide", provide } })]).state).toBe(
        "elsewhere"
      );
    }
  });

  it("a criterion slot whose ask is not the Pass / Fail grade is answered elsewhere", () => {
    expect(read([owed({ kind: "criterion", ask: CONFIRM })]).state).toBe(
      "elsewhere"
    );
  });
});

describe("the receipt — each settle says what it was; a refusal never makes one", () => {
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

  it("the receipt stands over any read, except an open one NEWER than it", () => {
    const receipt: AskReceipt = { kind: "answered", at: 200 };
    const open = (readAt: number) => ({ readAt }) as EmbedAskRead;
    const fresh = (state: string, extra = {}) =>
      ({ state, ...extra }) as EmbedAskRead;
    expect(receiptStands(read([owed()]), null)).toBe(false);
    // the page's refetch lands: answered, closed (a hand-back), failed
    expect(receiptStands(fresh("answered"), receipt)).toBe(true);
    expect(receiptStands(fresh("closed"), receipt)).toBe(true);
    expect(receiptStands(fresh("failed"), receipt)).toBe(true);
    // the card on screen was read before the answer: still the receipt
    expect(
      receiptStands({ ...open(100), state: "open" } as never, receipt)
    ).toBe(true);
    // asked again: a read NEWER than the answer shows the card
    expect(
      receiptStands({ ...open(300), state: "open" } as never, receipt)
    ).toBe(false);
  });
});

describe("the ask-embed catalog", () => {
  it("translates every English key, with the same arguments", () => {
    expect(catalogProblems({ en, fr })).toEqual([]);
  });
});
