/**
 * The shared readers every ask surface used to re-derive on its own:
 * `askCardSlotOf` (each surface dropped a different field), `slotAwaitsTap`
 * (decided three ways), `relayRecordedAnswer` (Confirm hid what it records)
 * and `roomQuestionConfirmDoor` (a room question drew a Confirm with nothing
 * to press).
 */
import { describe, expect, it } from "vitest";
import {
  ASK_COPY,
  AskSchema,
  ROOM_POST_META_KEY,
  askCardSlotOf,
  askCardView,
  readRoomPostMeta,
  relayRecordedAnswer,
  roomQuestionConfirmDoor,
  slotAwaitsTap,
  type Ask,
  type AskCardSlot,
  type AskCardSlotSource,
} from "./index.js";
import { FATE_COPY } from "../proposals/fate.js";
import { lensRowOfNeedsYou } from "../lens/rows.js";

const DAY = 24 * 3_600_000;
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();
const ask = (a: unknown): Ask => AskSchema.parse(a);

const relay = {
  text: "Yes",
  value: { type: "confirm" as const, confirmed: true },
  relayedBy: "agent-1",
  quote: "yes, ship it",
  relayedAt: daysAgo(0),
};

describe("askCardSlotOf — every field the card reads, from any row", () => {
  // One case per field a surface used to drop; each names what it read wrong.
  it("a kept-owed confirm does not read 'Ends with the session'", () => {
    const view = askCardView(
      askCardSlotOf({
        label: "Ship the draft?",
        ask: ask({ mode: "confirm" }),
        owedSince: daysAgo(1),
        keptOwedAt: daysAgo(0),
      }),
      { now: NOW }
    );
    expect(view.ageFate.fate.kind).toBe("until_decided");
  });

  it("a slot relayed today after 8 days owed is not in Review later", () => {
    const view = askCardView(
      askCardSlotOf({
        expectedLabel: "Ship the draft?",
        title: "a projection's title",
        ask: ask({ mode: "confirm" }),
        owedSince: daysAgo(8),
        pendingRelay: relay,
      }),
      { now: NOW }
    );
    expect(view.ageFate.fate.kind).not.toBe("review_later");
    expect(view.heading).toBe("Ship the draft?");
  });

  it("a param slot names its cause", () => {
    const view = askCardView(
      askCardSlotOf({ label: "Channel", paramName: "channel" }),
      { now: NOW }
    );
    expect(view.asker).toMatchObject({
      kind: "cause",
      cause: { kind: "param" },
    });
  });

  it("names the asker from the row's askedByName when the caller passes none", () => {
    const view = askCardView(
      askCardSlotOf({ label: "X", askedBy: "a1", askedByName: "Scout" }),
      { sessionId: "s1" }
    );
    expect(view.asker).toEqual({
      kind: "agent",
      name: "Scout",
      sessionId: "s1",
    });
  });

  it("reads a needs-you signal by its own names: slotKind, occurredAt, by", () => {
    const signal: AskCardSlotSource = {
      kind: "owed-slot",
      title: "Pick the plan",
      slotKind: "criterion",
      occurredAt: new Date(daysAgo(2)),
      by: { id: "a1", label: "Scout" },
      keptOwedAt: daysAgo(1),
    };
    const slot = askCardSlotOf(signal);
    expect(slot).toMatchObject<Partial<AskCardSlot>>({
      label: "Pick the plan",
      kind: "criterion",
      owedSince: daysAgo(2),
      askedBy: "a1",
      askedByName: "Scout",
      keptOwedAt: daysAgo(1),
    });
  });

  it("never takes the signal discriminator for the slot's kind", () => {
    expect(askCardSlotOf({ kind: "owed-slot", title: "X" }).kind).toBeNull();
    expect(askCardSlotOf({ kind: "decision", label: "X" }).kind).toBe(
      "decision"
    );
  });

  it("reads occurredAt and by only off a signal", () => {
    const slot = askCardSlotOf({
      label: "X",
      occurredAt: daysAgo(3),
      by: { id: "a1", label: "Scout" },
    });
    expect(slot.owedSince).toBeNull();
    expect(slot.askedByName).toBeNull();
  });
});

describe("lensRowOfNeedsYou reads the signal through the one adapter", () => {
  it("a param slot's row names its cause from paramName alone", () => {
    const row = lensRowOfNeedsYou(
      {
        kind: "item",
        key: "slot:s1:channel",
        signal: {
          id: "slot:s1:channel",
          kind: "owed-slot",
          title: "Channel",
          count: 1,
          groupKey: "session:s1",
          ageBucket: "recent",
          repeatCount: 1,
          occurredAt: daysAgo(1),
          paramName: "channel",
        },
        session: null,
      },
      "blocking"
    );
    expect(row.cause?.label).toBe(ASK_COPY.askCause("param", null));
  });
});

describe("slotAwaitsTap — the one 'awaiting your tap' predicate", () => {
  it.each([
    [
      "a pending relay on an owed slot",
      { owner: "human", pendingRelay: relay },
      true,
    ],
    [
      "a row that omits owner (a signal lists only owed slots)",
      { pendingRelay: relay },
      true,
    ],
    [
      // re-asked: the old answer stays on the slot, the relay is for the new ask
      "a re-asked slot still carrying its old answer",
      { owner: "human", answer: { text: "No" }, pendingRelay: relay },
      true,
    ],
    ["no relay", { owner: "human" }, false],
    [
      "handed back to the agent",
      { owner: "agent", pendingRelay: relay },
      false,
    ],
    ["done", { owner: "human", done: true, pendingRelay: relay }, false],
    [
      "done by status",
      { owner: "human", status: "done", pendingRelay: relay },
      false,
    ],
    [
      "retired",
      { owner: "human", retiredAt: daysAgo(0), pendingRelay: relay },
      false,
    ],
    [
      "attested",
      { owner: "human", attestedAt: daysAgo(0), pendingRelay: relay },
      false,
    ],
  ] as const)("%s", (_n, slot, want) => {
    expect(slotAwaitsTap(slot)).toBe(want);
  });

  it("no slot waits for nothing", () => {
    expect(slotAwaitsTap(null)).toBe(false);
  });
});

describe("relayRecordedAnswer — what Confirm records, as the card draws it", () => {
  it("a confirm reads its button's own label, with the quote under it", () => {
    const confirm = ask({
      mode: "confirm",
      yes: { label: "Ship it", recommended: true },
    });
    const read = relayRecordedAnswer(confirm, relay);
    expect(read).toMatchObject({
      label: "Ship it",
      answer: { key: "yes", tone: "positive", icon: "check" },
      quote: "yes, ship it",
    });
    expect(ASK_COPY.youSaid(read!.quote!)).toBe("You said “yes, ship it”");
  });

  it("a choose reads the option the relay picked", () => {
    const choose = ask({
      mode: "choose",
      options: [
        { label: "EU account", value: "eu" },
        { label: "US account", value: "us" },
      ],
    });
    const read = relayRecordedAnswer(choose, {
      text: "US account",
      value: { type: "chip", chip: { label: "US account", value: "us" } },
      quote: " ",
    });
    expect(read).toMatchObject({
      label: "US account",
      answer: { key: "us" },
      quote: null,
    });
  });

  it("an option the ask no longer offers keeps the relayed chip's label", () => {
    const read = relayRecordedAnswer(
      ask({ mode: "choose", options: [{ label: "A" }] }),
      {
        text: "Gone — note",
        value: { type: "chip", chip: { label: "Gone" } },
      }
    );
    expect(read).toEqual({ label: "Gone", answer: null, quote: null });
  });

  it("a confirm with no ask at hand still says Yes / No, never the noted text", () => {
    expect(
      relayRecordedAnswer(null, {
        text: "No — not this week",
        value: { type: "confirm", confirmed: false },
      })?.label
    ).toBe(ASK_COPY.no);
  });

  it("words with no typed value are the recorded text", () => {
    expect(relayRecordedAnswer(null, { text: " Friday at ten " })?.label).toBe(
      "Friday at ten"
    );
  });

  it("is null with no relay, or nothing to say", () => {
    expect(relayRecordedAnswer(null, null)).toBeNull();
    expect(relayRecordedAnswer(null, { text: "  " })).toBeNull();
  });
});

describe("roomQuestionConfirmDoor — which door a room question's Confirm uses", () => {
  const meta = (m: Record<string, unknown>) =>
    readRoomPostMeta({ [ROOM_POST_META_KEY]: m });

  it("a relay waiting on a slot-backed question confirms by the slot's label", () => {
    expect(
      roomQuestionConfirmDoor(
        meta({
          kind: "question",
          slotLabel: " Stripe account ",
          pendingRelay: relay,
        })
      )
    ).toEqual({ kind: "slot", expectedLabel: "Stripe account" });
  });

  it("an open approval card is its own door, never a Confirm pair", () => {
    expect(
      roomQuestionConfirmDoor(
        meta({ kind: "question", slotLabel: "Run it", confirmationId: "evt_1" })
      )
    ).toEqual({ kind: "approval", confirmationId: "evt_1" });
  });

  it.each([
    [
      "an open question waits for an answer, not a tap",
      { kind: "question", slotLabel: "X" },
    ],
    [
      "a slotless relay has no Confirm door",
      { kind: "question", pendingRelay: relay },
    ],
    [
      "an answered approval card",
      {
        kind: "question",
        confirmationId: "evt_1",
        answer: {
          messageId: "m",
          answeredBy: "u",
          answeredAt: "t",
          text: "ok",
        },
      },
    ],
    [
      "a question its session closed over a pending relay",
      {
        kind: "question",
        slotLabel: "X",
        pendingRelay: relay,
        closed: { reason: "session_ended", at: "t" },
      },
    ],
    ["an update", { kind: "update", slotLabel: "X", pendingRelay: relay }],
  ] as const)("%s → null", (_n, m) => {
    expect(roomQuestionConfirmDoor(meta(m))).toBeNull();
  });

  it("no marker → null", () => {
    expect(roomQuestionConfirmDoor(readRoomPostMeta({}))).toBeNull();
  });
});

describe("the relay mark is a mark", () => {
  it("names the relaying agent and the tap, and never instructs", () => {
    expect(ASK_COPY.awaitingYourTap("Scout")).toBe(
      "Relayed by Scout · needs your tap"
    );
    expect(ASK_COPY.awaitingYourTap(" ")).toBe("Relayed · needs your tap");
    expect(ASK_COPY.awaitingYourTap(null)).not.toMatch(/confirm/i);
  });

  it("the receipts after the pair", () => {
    expect(ASK_COPY.relayConfirmedReceipt(" Ship the draft? ")).toBe(
      "Confirmed · Ship the draft?"
    );
    expect(ASK_COPY.relayRejectedReceipt).toBe(
      "Not recorded · the question is yours again"
    );
    expect(FATE_COPY.nothingNewWaiting).toBe("Nothing new is waiting on you.");
  });
});

describe("the card's age, in marks and in words", () => {
  it("says when it was asked, and the same in full words for a screen reader", () => {
    const view = askCardView(
      {
        label: "X",
        ask: ask({ mode: "act", steps: ["a"] }),
        owedSince: daysAgo(1),
      },
      { now: NOW }
    );
    expect(view.ageFate.label).toBe("Asked 1d ago · Stays until you decide");
    expect(view.ageFate.spoken).toBe(
      "Asked 1 day ago · Stays until you decide"
    );
  });

  it("an unstamped ask says its fate alone, in both", () => {
    const view = askCardView({ label: "X" }, { now: NOW });
    expect(view.ageFate.label).toBe(FATE_COPY.untilDecided);
    expect(view.ageFate.spoken).toBe(FATE_COPY.untilDecided);
  });

  it("a page-partial Review later count reads as a floor", () => {
    expect(FATE_COPY.reviewLaterFold(12, true)).toBe("Review later · 12+");
    expect(FATE_COPY.reviewLaterFold(3)).toBe("Review later · 3");
  });
});
