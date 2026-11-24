import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogProblems } from "../i18n/index.js";
import {
  ASK_EMBED_HIDDEN_CODES,
  askCardReceipt,
  askEmbedRead,
  askEmbedRef,
  findAskSlot,
  receiptStands,
  type AskCardEvent,
  type AskReceipt,
  type AskSettleKind,
  type EmbedAskRead,
} from "./embed.js";
import { askEmbedCopy } from "./embed-copy.js";
import { askCardSlotOf, askCardView } from "./card.js";

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
      key: "ship-it",
      stored: { label: "Ship it?", ask: CONFIRM },
      source: {
        kind: "owed-slot",
        title: "Ship it?",
        ask: CONFIRM,
        target: { kind: "session", id: SESSION },
        sessionTitle: "Launch",
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
      asker: { id: "agent-1", name: "Claude-code" },
      source: { by: { id: "agent-1", label: "Claude-code" } },
    });
  });

  it("the answer's key is the MATCHED slot's key, not the shared label", () => {
    const slots = [
      owed({ key: "ship-it", owner: "agent", answer: { text: "old" } }),
      owed({ key: "ship-it-2" }),
    ];
    const r = read(slots, {}, "Ship it?");
    if (r.state !== "open") throw new Error("expected open");
    expect(r.key).toBe("ship-it-2");
  });

  it("one derivation: the card view is built from the source, no surface derives it", () => {
    const r = read([owed({ askedBy: "agent-1" })], {
      participants: [{ id: "agent-1", name: "Claude-code" }],
    });
    if (r.state !== "open") throw new Error("expected open");
    const card = askCardView(askCardSlotOf(r.source), {
      sessionId: SESSION,
      now: Date.parse("2026-11-16T09:05:00.000Z"),
    });
    expect(card.asker).toMatchObject({ name: "Claude-code" });
    expect(card.heading).toBeTruthy();
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
    const grade = {
      mode: "choose",
      options: [
        { label: "Pass", value: "pass" },
        { label: "Fail", value: "fail" },
      ],
    };
    expect(read([owed({ kind: "criterion", ask: grade })]).state).toBe("open");
  });
});

describe("the receipt — each settle says what it was; a refusal never makes one", () => {
  const settle = (events: AskCardEvent[]) =>
    events.reduce(askCardReceipt, null as AskReceipt | null);

  it.each([
    "answered",
    "attested",
    "handed-back",
    "refused",
  ] as const satisfies readonly AskSettleKind[])(
    "a %s settle sets a receipt of that kind",
    (kind) => {
      const events: AskCardEvent[] = [{ type: "settled", kind, at: 5 }];
      expect(settle(events)).toEqual({ kind, at: 5 });
    }
  );

  it("a refusal that moved on leaves it unset", () => {
    expect(settle([{ type: "moved-on" }])).toBeNull();
    // …and it never erases a receipt that is already there
    const kept: AskReceipt = { kind: "answered", at: 1 };
    expect(askCardReceipt(kept, { type: "moved-on" })).toBe(kept);
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

describe("the hidden-codes rule and the embed ref", () => {
  it("hides NOT_FOUND, FORBIDDEN, BAD_REQUEST; UNAUTHORIZED is never hidden", () => {
    expect([...ASK_EMBED_HIDDEN_CODES].sort()).toEqual([
      "BAD_REQUEST",
      "FORBIDDEN",
      "NOT_FOUND",
    ]);
    const code = (c: string) =>
      askEmbedRead(
        { isLoading: false, error: { data: { code: c } }, data: undefined },
        { sessionId: SESSION, slot: "x" }
      ).state;
    expect(code("BAD_REQUEST")).toBe("hidden");
    expect(code("UNAUTHORIZED")).toBe("failed");
  });

  it("a ref needs both attributes, trimmed", () => {
    expect(askEmbedRef({ sessionId: " s ", slot: " k " })).toEqual({
      sessionId: "s",
      slot: "k",
    });
    expect(askEmbedRef({ sessionId: "s" })).toBeNull();
    expect(askEmbedRef({ sessionId: "s", slot: "  " })).toBeNull();
  });
});

describe("the shared model stays a leaf", () => {
  it.each(["./embed.ts", "./embed-copy.ts"])(
    "%s has no direct bare import and no lookbehind",
    (file) => {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      const specs = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      expect(specs.length).toBeGreaterThan(0);
      expect(specs.filter((s) => !s.startsWith("."))).toEqual([]);
      expect(src).not.toMatch(/\(\?<[=!]/);
    }
  );
});

describe("the ask-embed catalog", () => {
  it("translates every English key, with the same arguments", () => {
    expect(catalogProblems(askEmbedCopy)).toEqual([]);
  });
});
