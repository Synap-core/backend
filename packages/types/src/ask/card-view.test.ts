/**
 * The ask card's ONE anatomy (founder decisions, 2026-10-26):
 * `askCardView`, `askFate`, the confirm's recommendation + consequences.
 *
 * The first case is the founder's own card, verbatim in shape: a decision
 * note's title, "Decide: …" as the label, "Accept: …?" as the prompt and the
 * summary as `why` — five copies of one sentence, under "An agent. It is
 * waiting on your answer."
 */
import { describe, expect, it } from "vitest";
import {
  AskSchema,
  ASK_COPY,
  askCardView,
  askFate,
  answerProvenanceMark,
  answerWasRelayed,
  askRecommendationOutcome,
  readRoomPostMeta,
  ROOM_POST_META_KEY,
  buildAskSnapshot,
  stripLeadingRestatement,
  isAskReviewLater,
  type Ask,
  type AskCardSlot,
} from "./index.js";
import { FATE_TONE, REVIEW_LATER_AFTER_DAYS } from "../proposals/fate.js";
import { proposalFateLine } from "../lens/rows.js";

const DAY = 24 * 3_600_000;
const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();
const ask = (a: unknown): Ask => AskSchema.parse(a);

describe("askCardView — the founder's card", () => {
  const title =
    "Four observations will confirm or kill H1 and H2 by the end of the quarter";
  const slot: AskCardSlot = {
    label: `Decide: ${title}`,
    owner: "human",
    blockedReason: "decision",
    why: `${title}. Each one is dated and falsifiable.`,
    ask: ask({ mode: "confirm", prompt: `Accept: ${title}?` }),
    owedSince: daysAgo(8),
    askCause: {
      kind: "decision",
      ref: { kind: "entity", id: "3fa5e462" },
      at: "2026-09-29T10:00:00.000Z",
    },
  };
  const view = askCardView(slot, { now: NOW, sessionId: "s1" });

  it("says the question ONCE: the prompt, its verb prefix stripped", () => {
    expect(view.heading).toBe(`${title}?`);
    // The why starts with the heading's core: it adds nothing.
    expect(view.context).toBeNull();
  });

  it("names the CAUSE as a door when no agent asked, never 'An agent'", () => {
    expect(view.asker).toMatchObject({
      kind: "cause",
      cause: { kind: "decision", ref: { kind: "entity", id: "3fa5e462" } },
    });
    expect(view.asker?.kind === "cause" && view.asker.label).toMatch(
      /^From a proposed decision · /
    );
    expect(JSON.stringify(view)).not.toMatch(/an agent|waiting on your/i);
  });

  it("age and fate are ONE mark; 8 days owed is Review later", () => {
    expect(view.ageFate).toMatchObject({
      label: "Asked 8d ago · In Review later",
      spoken: "Asked 8 days ago · In Review later",
      tone: "textMuted",
      fate: { kind: "review_later" },
    });
  });

  it("Yes / No carry an icon and a tone; the note is one collapsed label", () => {
    expect(view.answers.map((a) => [a.key, a.label, a.icon, a.tone])).toEqual([
      ["yes", "Yes", "check", "positive"],
      ["no", "No", "x", "neutral"],
    ]);
    expect(view.note).toEqual({ label: ASK_COPY.addNote });
  });
});

describe("askCardView — heading and context", () => {
  it("non-confirm: the label is the heading, prefix stripped", () => {
    expect(
      askCardView({ label: "Answer: Which channel?", ask: null }).heading
    ).toBe("Which channel?");
    expect(askCardView({ label: "Answer:" }).heading).toBe("Answer:");
  });

  it("keeps a why that ADDS, in full", () => {
    const v = askCardView({
      label: "Stripe key",
      why: "The restricted key for the live account, read-only.",
    });
    expect(v.context).toBe(
      "The restricted key for the live account, read-only."
    );
  });

  it("drops a why equal to the prompt, whatever its case or punctuation", () => {
    const v = askCardView({
      label: "Keep the run going",
      why: "keep it going",
      ask: ask({ mode: "confirm", prompt: "Keep it going?" }),
    });
    expect(v.heading).toBe("Keep it going?");
    expect(v.context).toBeNull();
  });

  it("a why that only shares a first WORD with the heading is kept", () => {
    const v = askCardView({
      label: "Ship",
      why: "Shipping is blocked by the review",
    });
    expect(v.context).toBe("Shipping is blocked by the review");
  });
});

describe("askCardView — the asker", () => {
  it("a named agent wins over any cause; its session is the door", () => {
    const v = askCardView(
      { label: "X", askCause: { kind: "run" } },
      { askerName: "Claude Code", sessionId: "s9" }
    );
    expect(v.asker).toEqual({
      kind: "agent",
      name: "Claude Code",
      sessionId: "s9",
    });
  });

  it("a criterion / param slot names its cause from its own stamps", () => {
    expect(askCardView({ label: "X", criterionKey: "k" }).asker).toMatchObject({
      kind: "cause",
      label: "From the session's checks",
    });
    expect(
      askCardView({ label: "X", paramName: "channel" }).asker
    ).toMatchObject({ kind: "cause", label: "From the playbook's inputs" });
  });

  it("nobody to name ⇒ null, never a guessed one", () => {
    expect(askCardView({ label: "X" }, { askerName: "  " }).asker).toBeNull();
  });
});

describe("askCardView — answers", () => {
  it("a confirm may recommend one answer and state each consequence", () => {
    const v = askCardView({
      label: "Positioning decision",
      ask: ask({
        mode: "confirm",
        prompt: "Accept this decision?",
        yes: {
          label: "Accept",
          description: "Marks it accepted",
          recommended: true,
        },
        no: { description: "Marks it rejected" },
      }),
    });
    expect(v.answers).toEqual([
      {
        key: "yes",
        label: "Accept",
        description: "Marks it accepted",
        recommended: true,
        tone: "positive",
        icon: "check",
      },
      {
        key: "no",
        label: "No",
        description: "Marks it rejected",
        recommended: false,
        tone: "neutral",
        icon: "x",
      },
    ]);
  });

  it("a choose keeps its options; form/act/provide draw their own region", () => {
    const v = askCardView({
      label: "Tone",
      ask: ask({
        mode: "choose",
        options: [
          {
            label: "Casual",
            value: "c",
            recommended: true,
            description: "Warm",
          },
          { label: "Formal" },
        ],
      }),
    });
    expect(v.answers.map((a) => [a.key, a.recommended, a.description])).toEqual(
      [
        ["c", true, "Warm"],
        ["Formal", false, null],
      ]
    );
    expect(
      askCardView({ label: "Key", ask: ask({ mode: "act", steps: ["a"] }) })
        .answers
    ).toEqual([]);
  });

  it("a decision slot with no ask answers Yes / No (the derived confirm)", () => {
    const v = askCardView({
      label: "Pick",
      owner: "human",
      blockedReason: "decision",
    });
    expect(v.answers.map((a) => a.key)).toEqual(["yes", "no"]);
  });

  it("no card string carries an em dash", () => {
    const v = askCardView(
      { label: "X", owedSince: daysAgo(1), askCause: { kind: "gate" } },
      { now: NOW }
    );
    expect(JSON.stringify(v)).not.toContain("—");
  });
});

describe("askFate — the owed ask's fate on silence", () => {
  const confirm = ask({ mode: "confirm" });
  const act = ask({ mode: "act", steps: ["do it"] });

  it("a confirm / choose retires when its session ends; act stays", () => {
    expect(
      askFate({ label: "a", ask: confirm, owedSince: daysAgo(1) }, NOW)
    ).toEqual({ kind: "ends_with_session" });
    expect(
      askFate({ label: "a", ask: act, owedSince: daysAgo(1) }, NOW)
    ).toEqual({ kind: "until_decided" });
    expect(
      askCardView(
        { label: "a", ask: confirm, owedSince: daysAgo(2) },
        { now: NOW }
      ).ageFate.label
    ).toBe("Asked 2d ago · Ends with the session");
  });

  it("a fate with no deadline is never amber; it reads as the proposal's", () => {
    // Most confirms end with their session: an amber mark on each would stop
    // meaning "act soon". Same words and tone as a session-bound draft.
    const view = askCardView(
      { label: "a", ask: confirm, owedSince: daysAgo(2) },
      { now: NOW }
    );
    expect(view.ageFate.tone).toBe(FATE_TONE.dies_with_session);
    expect(view.ageFate.tone).not.toBe("warning");
    expect(view.ageFate.label).toBe(
      `Asked 2d ago · ${proposalFateLine({ kind: "dies_with_session" }, NOW)}`
    );
  });

  it("past REVIEW_LATER_AFTER_DAYS: Review later, any mode, never expired", () => {
    const edge = REVIEW_LATER_AFTER_DAYS;
    expect(isAskReviewLater({ owedSince: daysAgo(edge - 0.01) }, NOW)).toBe(
      false
    );
    expect(isAskReviewLater({ owedSince: daysAgo(edge + 0.01) }, NOW)).toBe(
      true
    );
    expect(
      askFate({ label: "a", ask: act, owedSince: daysAgo(edge + 1) }, NOW)
    ).toEqual({
      kind: "review_later",
      since: new Date(NOW - DAY).toISOString(),
    });
  });

  it("a criterion grade never retires with its session, though its ask is a choose", () => {
    const grade = ask({
      mode: "choose",
      options: [
        { label: "Pass", value: "pass" },
        { label: "Fail", value: "fail" },
      ],
    });
    expect(
      askFate(
        { label: "a", kind: "criterion", ask: grade, owedSince: daysAgo(1) },
        NOW
      )
    ).toEqual({ kind: "until_decided" });
    expect(
      askFate(
        { label: "a", criterionKey: "tests", ask: grade, owedSince: daysAgo(1) },
        NOW
      )
    ).toEqual({ kind: "until_decided" });
  });

  it("a relay waiting for the tap is fresh news, whatever the slot's age", () => {
    const old = daysAgo(REVIEW_LATER_AFTER_DAYS + 3);
    expect(isAskReviewLater({ owedSince: old }, NOW)).toBe(true);
    expect(
      isAskReviewLater(
        { owedSince: old, pendingRelay: { relayedAt: daysAgo(0.1) } },
        NOW
      )
    ).toBe(false);
    // A relay left waiting past the window ages out like anything else.
    expect(
      isAskReviewLater(
        {
          owedSince: old,
          pendingRelay: { relayedAt: daysAgo(REVIEW_LATER_AFTER_DAYS + 1) },
        },
        NOW
      )
    ).toBe(true);
  });

  it("an unreadable owedSince fails toward KEEPING it in the headline", () => {
    expect(isAskReviewLater({ owedSince: "0000-00-00" }, NOW)).toBe(false);
    expect(isAskReviewLater({ owedSince: null }, NOW)).toBe(false);
    expect(askCardView({ label: "a", ask: act }).ageFate.label).toBe(
      "Stays until you decide"
    );
  });
});

describe("a confirm's recommendation — the contract", () => {
  it("at most ONE of yes / no may be recommended (refused at the parse)", () => {
    expect(
      AskSchema.safeParse({
        mode: "confirm",
        yes: { recommended: true },
        no: { recommended: true },
      }).success
    ).toBe(false);
    expect(
      AskSchema.safeParse({ mode: "confirm", no: { recommended: true } })
        .success
    ).toBe(true);
  });

  it("the snapshot records it, and the outcome reads followed / overrode", () => {
    const a = ask({ mode: "confirm", yes: { recommended: true } });
    const followed = buildAskSnapshot(a, { type: "confirm", confirmed: true });
    expect(followed).toMatchObject({
      chosenKey: "yes",
      recommendedKey: "yes",
      followedRecommendation: true,
    });
    expect(askRecommendationOutcome(followed).outcome).toBe("followed");

    const overrode = buildAskSnapshot(a, { type: "confirm", confirmed: false });
    expect(askRecommendationOutcome(overrode)).toEqual({
      outcome: "overrode",
      recommendedLabel: "Yes",
    });
  });

  it("no recommendation stays `none` — never 'overrode' advice nobody gave", () => {
    const snap = buildAskSnapshot(ask({ mode: "confirm" }), {
      type: "confirm",
      confirmed: false,
    });
    expect(snap.followedRecommendation).toBeNull();
    expect(askRecommendationOutcome(snap).outcome).toBe("none");
  });
});

describe("stripLeadingRestatement — one fold with askTextRestates", () => {
  it("strips the restated lead in any case and keeps the rest", () => {
    expect(
      stripLeadingRestatement(
        "Pricing model: use three tiers",
        "pricing model"
      )
    ).toBe("use three tiers");
    expect(
      stripLeadingRestatement("Decide: pricing MODEL. Seats.", "Pricing model")
    ).toBe("Seats.");
  });
  it("all of it restated ⇒ empty; not restated ⇒ untouched", () => {
    expect(stripLeadingRestatement("Pricing model.", "pricing model")).toBe("");
    expect(
      stripLeadingRestatement("Seats are cheaper.", "Pricing model")
    ).toBe("Seats are cheaper.");
    // A longer word that merely starts with the lead is not a restatement.
    expect(
      stripLeadingRestatement("Pricing models differ.", "Pricing model")
    ).toBe("Pricing models differ.");
  });
});

describe("relayed answers — one reader, one receipt", () => {
  it("answerWasRelayed: a relay stays a relay once the person confirmed it", () => {
    expect(answerWasRelayed({ via: "relayed", relayedBy: "a1" })).toBe(true);
    expect(answerWasRelayed({ via: "tap", relayedBy: "a1" })).toBe(true);
    expect(answerWasRelayed({ via: "tap" })).toBe(false);
    expect(answerWasRelayed(null)).toBe(false);
  });
  it("ASK_COPY.relayedWords shows the person's QUOTE over the recorded text", () => {
    expect(ASK_COPY.relayedWords({ quote: "ship it", text: "Yes" })).toBe(
      "“ship it”"
    );
    expect(ASK_COPY.relayedWords({ text: "Yes" })).toBe("“Yes”");
    expect(ASK_COPY.relayedWords({ quote: " ", text: null })).toBeNull();
  });
});

describe("readRoomPostMeta — the one reader of a room question's marker", () => {
  it("reads the stamp the pod writes, and drives the question's mark", () => {
    const meta = readRoomPostMeta({
      [ROOM_POST_META_KEY]: {
        kind: "question",
        closed: { reason: "session_ended", at: "2026-10-26T12:00:00.000Z" },
      },
    });
    expect(meta?.kind).toBe("question");
    expect(answerProvenanceMark(meta!)).toEqual({
      tone: "textMuted",
      label: ASK_COPY.closedSessionEnded,
      disposition: "closed_session_ended",
    });
  });
  it("anything else is not a room post", () => {
    expect(readRoomPostMeta(null)).toBeNull();
    expect(readRoomPostMeta({ [ROOM_POST_META_KEY]: { kind: "chat" } })).toBeNull();
  });
});
