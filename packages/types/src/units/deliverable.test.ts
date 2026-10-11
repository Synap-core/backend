import { describe, it, expect } from "vitest";
import {
  deliverableOwedBy,
  isDeliverableOutstanding,
  resolveDeliverableState,
  tallyDeliverables,
  type DeliverableFacts,
} from "./deliverable.js";

const RETIRED = "2026-09-05T00:00:00.000Z";

/**
 * Every row names the rule it RULES OUT. The candidates are the rules this one
 * replaced or nearly became:
 *   A. `owner === "agent"` for the session's side (drops the pre-`owner` corpus)
 *   B1. retirement checked on the human branch only (a retired AGENT slot
 *      then still reads owed by the session — "working")
 *   B2. retirement checked on the agent branch only (a retired HUMAN slot
 *      then still reads "needs you")
 *   I. `!retiredAt` as "not retired" (a stamped-but-empty `""` reads owed,
 *      while the pod's SQL — `retiredAt IS NULL` — reads it retired)
 *   C. `status === "pending"` as "outstanding" (an unknown status reads done)
 *   D. owner checked before done (a delivered human slot reads "needs you")
 *   E. owner checked before the agent's claim (R6's first draft: a claimed
 *      human slot reads "needs you" when the act asked is a judgement)
 *   F. "delegated ⇒ working" (a slot handed BACK reads as moving)
 *   G. "returned" checked before the owner (a returned slot the person now
 *      owns reads "blocked" — waiting on X — when it is waiting on YOU)
 *   H. "the session's ⇒ working" whatever the session (a closed session's
 *      undelivered slot reads as being worked)
 */
const FIXTURES: Array<{
  name: string;
  slot: DeliverableFacts;
  terminal: boolean;
  owedBy: "you" | "session" | null;
  state: string;
  rulesOut: string;
}> = [
  {
    name: "absent owner, pending",
    slot: {},
    terminal: false,
    owedBy: "session",
    state: "working",
    rulesOut: "A",
  },
  {
    name: "human, pending",
    slot: { owner: "human" },
    terminal: false,
    owedBy: "you",
    state: "needs_you",
    rulesOut: "—",
  },
  {
    name: "human, retired",
    slot: { owner: "human", retiredAt: RETIRED },
    terminal: true,
    owedBy: null,
    state: "done",
    rulesOut: "B2",
  },
  {
    name: "agent, retired",
    slot: { owner: "agent", retiredAt: RETIRED },
    terminal: false,
    owedBy: null,
    state: "done",
    rulesOut: "B1",
  },
  {
    name: "human, retired with an empty stamp",
    slot: { owner: "human", retiredAt: "" },
    terminal: false,
    owedBy: null,
    state: "done",
    rulesOut: "I",
  },
  {
    name: "unknown status",
    slot: { status: "archived", owner: "human" },
    terminal: false,
    owedBy: "you",
    state: "needs_you",
    rulesOut: "C",
  },
  {
    name: "human, done",
    slot: { owner: "human", status: "done" },
    terminal: false,
    owedBy: null,
    state: "done",
    rulesOut: "D",
  },
  {
    name: "human, claimed done",
    slot: { owner: "human", claimedDone: true },
    terminal: false,
    owedBy: "you",
    state: "needs_review",
    rulesOut: "E",
  },
  {
    name: "agent, returned",
    slot: { owner: "agent", returnedReason: "no access" },
    terminal: false,
    owedBy: "session",
    state: "blocked",
    rulesOut: "F",
  },
  {
    name: "human, returned",
    slot: { owner: "human", returnedReason: "no access" },
    terminal: false,
    owedBy: "you",
    state: "needs_you",
    rulesOut: "G",
  },
  {
    name: "agent, session closed",
    slot: { owner: "agent" },
    terminal: true,
    owedBy: "session",
    state: "not_started",
    rulesOut: "H",
  },
];

describe("deliverable state — the discriminating table", () => {
  for (const f of FIXTURES) {
    it(`${f.name} → ${f.owedBy ?? "nobody"} / ${f.state} (rules out ${f.rulesOut})`, () => {
      expect(deliverableOwedBy(f.slot)).toBe(f.owedBy);
      expect(
        resolveDeliverableState(f.slot, { sessionTerminal: f.terminal }).state
      ).toBe(f.state);
    });
  }

  it("a done slot on a terminal session reads done — never needs_you, whoever owned it", () => {
    for (const owner of ["human", "agent", undefined]) {
      const view = resolveDeliverableState(
        { status: "done", ...(owner ? { owner } : {}) },
        { sessionTerminal: true }
      );
      expect(view.state, `owner=${owner}`).toBe("done");
    }
  });

  it("returns a tone and a glyph, never a colour", () => {
    const view = resolveDeliverableState(
      { owner: "human" },
      { sessionTerminal: false }
    );
    expect(view).toMatchObject({ tone: "primary", glyph: "person" });
  });

  it("outstanding and owed-by partition: retired and done are owed by nobody, symmetrically", () => {
    expect(isDeliverableOutstanding({ retiredAt: RETIRED })).toBe(false);
    for (const owner of ["human", "agent", undefined]) {
      expect(deliverableOwedBy({ owner, retiredAt: RETIRED })).toBeNull();
      expect(deliverableOwedBy({ owner, status: "done" })).toBeNull();
    }
  });
});

/**
 * OPTIONAL slots (`optional: true`, declared at birth). Each row names the
 * rival it rules out:
 *   O1. optional ignored — the unfilled slot reads owed ("needs you" / "working")
 *   O2. optional folded into "done" — the unfilled slot reads delivered
 *   O3. optional checked before `done` — a FILLED optional slot loses its mark
 *   O4. `!optional` / truthy test — a non-`true` value (`"false"`) lets go
 */
describe("optional slots — owed by nobody, still produced when filled", () => {
  it("an unfilled optional HUMAN slot is owed by nobody and reads not_started (O1, O2)", () => {
    const slot = { owner: "human", optional: true };
    expect(isDeliverableOutstanding(slot)).toBe(false);
    expect(deliverableOwedBy(slot)).toBeNull();
    expect(
      resolveDeliverableState(slot, { sessionTerminal: false }).state
    ).toBe("not_started");
  });

  it("an unfilled optional AGENT slot is not 'working' either (O1)", () => {
    expect(deliverableOwedBy({ optional: true })).toBeNull();
    expect(
      resolveDeliverableState({ optional: true }, { sessionTerminal: false })
        .state
    ).toBe("not_started");
  });

  it("a FILLED optional slot reads done and counts as produced (O3)", () => {
    const slot = { optional: true, status: "done" };
    expect(
      resolveDeliverableState(slot, { sessionTerminal: false }).state
    ).toBe("done");
    expect(tallyDeliverables([slot, { optional: true }, {}])).toEqual({
      done: 1,
      total: 2,
      owedByYou: 0,
    });
  });

  it("only a real `true` lets go — anything else is still owed (O4)", () => {
    expect(
      deliverableOwedBy({
        owner: "human",
        optional: "false" as unknown as boolean,
      })
    ).toBe("you");
    expect(deliverableOwedBy({ owner: "human", optional: false })).toBe("you");
  });
});

describe("tallyDeliverables", () => {
  it("counts done, done+owed, and the person's owed — a retired slot is in no count", () => {
    expect(
      tallyDeliverables([
        { status: "done" },
        { status: "done", owner: "human" },
        { owner: "human" },
        { owner: "human", retiredAt: RETIRED },
        { owner: "agent" },
        {},
      ])
    ).toEqual({ done: 2, total: 5, owedByYou: 1 });
  });

  it("nothing declared is zero of zero, not a failure", () => {
    expect(tallyDeliverables([])).toEqual({ done: 0, total: 0, owedByYou: 0 });
  });
});
