import { describe, it, expect } from "vitest";
import type { SlotAnswer } from "@synap/playbooks";
import { buildAskSnapshot } from "@synap-core/types/ask";
import {
  decisionFromAnswer,
  decisionUpdateFromAnswer,
  askFilesDecision,
  CONFIRM_OPTIONS,
} from "../decision-from-answer.js";
import { lookedAtLinks } from "../file-answer-decision.js";

const CHOOSE = {
  mode: "choose" as const,
  options: [
    {
      label: "EU account",
      value: "eu",
      recommended: true,
      description: "bills in EUR",
    },
    { label: "US account", value: "us" },
  ],
};
const answerTo = (
  ask: Parameters<typeof buildAskSnapshot>[0],
  value: SlotAnswer["value"],
  text: string,
  why?: string
): SlotAnswer => ({
  text,
  messageId: null,
  answeredBy: "u",
  answeredAt: "2026-10-05T10:00:00.000Z",
  value,
  askSnapshot: buildAskSnapshot(ask, value, why),
});

describe("which asks file a decision", () => {
  it("confirm and choose do; form/act/provide/none do not", () => {
    expect(askFilesDecision({ mode: "confirm" })).toBe(true);
    expect(askFilesDecision({ mode: "choose" })).toBe(true);
    for (const mode of ["form", "act", "provide"]) {
      expect(askFilesDecision({ mode })).toBe(false);
    }
    expect(askFilesDecision(null)).toBe(false);
  });
});

describe("decisionFromAnswer — a choose", () => {
  const why = "Which account bills EU customers?";
  const answer = answerTo(
    CHOOSE,
    { type: "chip", chip: { label: "US account", value: "us" } },
    "US account — we already invoice from the US entity",
    why
  );
  const d = decisionFromAnswer({
    slot: { label: "Stripe account", ask: CHOOSE, why },
    answer,
    sessionId: "s1",
    askedByAgent: "agent-1",
  })!;

  it("title = the question; summary = the pick", () => {
    expect(d.title).toBe(why);
    expect(d.properties.summary).toBe("US account");
  });
  it("keeps the structured mesh: options, pick, recommendation, followed", () => {
    expect(d.properties).toMatchObject({
      decisionStatus: "accepted",
      decidedAt: "2026-10-05T10:00:00.000Z",
      decisionOptions: CHOOSE.options,
      chosenOption: "us",
      recommendedOption: "eu",
      followedRecommendation: false,
      sourceSessionId: "s1",
      askedByAgent: "agent-1",
    });
  });
  it("rationale = the person's note + why; alternatives = the others", () => {
    expect(d.properties.rationale).toBe(
      `we already invoice from the US entity\n\nAsked because: ${why}`
    );
    expect(d.properties.alternatives).toBe(
      "- EU account — bills in EUR (recommended)"
    );
  });
});

describe("decisionFromAnswer — a confirm", () => {
  const confirm = { mode: "confirm" as const, prompt: "Ship on Friday?" };
  it("files yes/no options; no recommendation ⇒ followedRecommendation ABSENT", () => {
    const d = decisionFromAnswer({
      slot: { label: "Ship", ask: confirm },
      answer: answerTo(confirm, { type: "confirm", confirmed: true }, "Yes"),
      sessionId: "s1",
    })!;
    expect(d.title).toBe("Ship on Friday?");
    expect(d.properties.decisionOptions).toEqual(CONFIRM_OPTIONS);
    expect(d.properties.chosenOption).toBe("yes");
    expect(d.properties).not.toHaveProperty("followedRecommendation");
    expect(d.properties.decisionStatus).toBe("accepted");
  });
  it("a No on a slot opened FOR a decision rejects it; an ordinary No is accepted", () => {
    const no = answerTo(confirm, { type: "confirm", confirmed: false }, "No");
    expect(
      decisionFromAnswer({
        slot: { label: "Ship", ask: confirm, decisionId: "d1" },
        answer: no,
        sessionId: "s1",
      })!.properties.decisionStatus
    ).toBe("rejected");
    expect(
      decisionFromAnswer({
        slot: { label: "Ship", ask: confirm },
        answer: no,
        sessionId: "s1",
      })!.properties.decisionStatus
    ).toBe("accepted");
  });
});

it("a form answer files nothing", () => {
  const form = {
    mode: "form" as const,
    form: { fields: [{ key: "k", label: "K", type: "text" }] },
  };
  expect(
    decisionFromAnswer({
      slot: { label: "F", ask: form },
      answer: answerTo(form, { type: "form", values: { k: "v" } }, "K: v"),
      sessionId: "s1",
    })
  ).toBeNull();
});

it("lookedAt edges skip non-endpoint kinds (view)", () => {
  const edges = lookedAtLinks("d1", null, [
    { kind: "entity", id: "e1" },
    { kind: "view", id: "v1" },
    { kind: "document", id: "doc1" },
  ]);
  expect(edges.map((e) => `${e.toType}:${e.toId}:${e.linkType}`)).toEqual([
    "entity:e1:about",
    "document:doc1:about",
  ]);
});

describe("decisionFromAnswer — relay provenance", () => {
  const pick = {
    type: "chip" as const,
    chip: { label: "EU account", value: "eu" },
  };
  const fileFor = (answer: SlotAnswer) =>
    decisionFromAnswer({
      slot: { label: "Stripe account", ask: CHOOSE },
      answer,
      sessionId: "s1",
    })!.properties;

  it("a tap carries none of it", () => {
    const p = fileFor(answerTo(CHOOSE, pick, "EU account"));
    expect(p.answeredVia).toBeUndefined();
    expect(p.relayedBy).toBeUndefined();
    expect(p.relayQuote).toBeUndefined();
  });

  it("a relayed answer says so, with who carried which words", () => {
    const p = fileFor({
      ...answerTo(CHOOSE, pick, "EU account"),
      via: "relayed",
      relayedBy: "agent-7",
      quote: "the EU one",
    });
    expect(p).toMatchObject({
      answeredVia: "relayed",
      relayedBy: "agent-7",
      relayQuote: "the EU one",
    });
  });

  it("a CONFIRMED relay reads tap, and keeps the relay", () => {
    const p = fileFor({
      ...answerTo(CHOOSE, pick, "EU account"),
      via: "tap",
      relayedBy: "agent-7",
      quote: "the EU one",
      confirmedAt: "2026-10-26T10:00:00.000Z",
    });
    expect(p).toMatchObject({
      answeredVia: "tap",
      relayedBy: "agent-7",
      relayQuote: "the EU one",
    });
  });
});

describe("decisionUpdateFromAnswer — an EXISTING decision (slot.decisionId)", () => {
  const slot = { label: "Stripe account", ask: CHOOSE, decisionId: "d1" };
  const pick = (value: string, label: string, text = label) =>
    answerTo(CHOOSE, { type: "chip", chip: { label, value } }, text);
  const draftOf = (answer: SlotAnswer) =>
    decisionFromAnswer({ slot, answer, sessionId: "s1" })!;

  it("writes what was decided, never the person's summary, options or rationale", () => {
    const answer = pick(
      "us",
      "US account",
      "US account — the US entity invoices"
    );
    const u = decisionUpdateFromAnswer({
      draft: draftOf(answer),
      previous: null,
      existing: {
        summary: "Bill EU customers from one account",
        decisionOptions: [{ label: "Theirs" }],
        rationale: "Tax is simpler.",
      },
      answer,
    });
    expect(u).toMatchObject({
      decisionStatus: "accepted",
      chosenOption: "us",
      recommendedOption: "eu",
      followedRecommendation: false,
      sourceSessionId: "s1",
      rationale: "Tax is simpler.\n\nWhen deciding: the US entity invoices",
    });
    for (const key of ["summary", "decisionOptions", "alternatives"]) {
      expect(u).not.toHaveProperty(key);
    }
  });

  it("no note ⇒ the rationale is not touched at all", () => {
    const answer = pick("eu", "EU account");
    const u = decisionUpdateFromAnswer({
      draft: draftOf(answer),
      previous: null,
      existing: { rationale: "Tax is simpler." },
      answer,
    });
    expect(u).not.toHaveProperty("rationale");
  });

  it("a re-answer revises the words the PREVIOUS answer wrote, and only those", () => {
    const first = draftOf(pick("eu", "EU account"));
    const answer = pick("us", "US account");
    const u = decisionUpdateFromAnswer({
      draft: draftOf(answer),
      previous: first,
      existing: { ...first.properties },
      answer,
    });
    expect(u.summary).toBe("US account");
    expect(u.alternatives).toBe("- EU account — bills in EUR (recommended)");

    const edited = decisionUpdateFromAnswer({
      draft: draftOf(answer),
      previous: first,
      existing: { ...first.properties, summary: "My own words" },
      answer,
    });
    expect(edited).not.toHaveProperty("summary");
  });
});

describe("decisionFromAnswer — a pick through a follow-up (the decision tree)", () => {
  const TREE = {
    mode: "choose" as const,
    options: [
      {
        label: "Ship it",
        followUp: {
          prompt: "Which environment?",
          options: [{ label: "Staging" }, { label: "Production" }],
        },
      },
      { label: "Wait" },
    ],
  };
  const why = "Release the billing fix?";
  const value = {
    type: "chip" as const,
    chip: { label: "Ship it" },
    then: { label: "Production" },
  };
  const d = decisionFromAnswer({
    slot: { label: "Release", ask: TREE, why },
    answer: answerTo(
      TREE,
      value,
      "Ship it → Production — after the freeze",
      why
    ),
    sessionId: "s1",
  })!;

  it("the summary is the whole path, and the note survives it", () => {
    expect(d.properties.summary).toBe("Ship it → Production");
    expect(d.properties.rationale).toMatch(/^after the freeze/);
  });
});
