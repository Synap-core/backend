import { describe, it, expect } from "vitest";
import type { SlotAnswer } from "@synap/playbooks";
import { buildAskSnapshot } from "@synap-core/types/ask";
import {
  decisionFromAnswer,
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
