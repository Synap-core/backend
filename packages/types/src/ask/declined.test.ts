/**
 * REFUSE (`{ type: "declined", reason? }`, `./declined.ts`): the person may
 * say no to EVERY ask. Each test names the rival rule it rules out:
 *   - "a refusal is a mode-specific answer" (act → `wrong_door`, confirm →
 *     `type_mismatch`, no ask → free text only): the five modes and the
 *     ask-less slot are each a row;
 *   - "the card offers an answer only on confirm / choose": `refuse` is on
 *     every card;
 *   - "a refusal is words": its summary is the vocabulary's past verb, and the
 *     reason the person typed reaches the agent's line.
 */
import { describe, expect, it } from "vitest";
import {
  AskAnswerValueSchema,
  ASK_LIMITS,
  buildAskSnapshot,
  declinedAnswerText,
  declinedReasonOf,
  isDeclinedAnswer,
  isDeclinedValue,
  resolveAskResolution,
  summarizeAnswer,
  validateAnswerAgainstAsk,
  type Ask,
} from "./index.js";
import { ASK_COPY, askCardView } from "./card.js";
import { deliverableUnitInput } from "../units/deliverable.js";
import { resolveActionLabel } from "../vocabulary/index.js";

const ASKS: Array<[string, Ask | null]> = [
  ["no ask", null],
  ["confirm", { mode: "confirm", prompt: "Publish today?" }],
  ["choose", { mode: "choose", options: [{ label: "EU" }, { label: "US" }] }],
  [
    "choose (closed)",
    {
      mode: "choose",
      allowOther: false,
      options: [{ label: "EU" }, { label: "US" }],
    },
  ],
  [
    "form",
    {
      mode: "form",
      form: {
        fields: [{ key: "repo", label: "Repo", type: "text", required: true }],
      },
    },
  ],
  ["act", { mode: "act", steps: ["Open the dashboard", "Rotate the key"] }],
  [
    "provide secret",
    { mode: "provide", provide: { kind: "secret", name: "GITHUB_TOKEN" } },
  ],
  [
    "provide connection",
    { mode: "provide", provide: { kind: "connection", service: "github" } },
  ],
  ["provide file", { mode: "provide", provide: { kind: "file" } }],
] as Array<[string, Ask | null]>;

describe("a refusal is taken for every ask, and stored as given", () => {
  for (const [name, ask] of ASKS) {
    it(`${name}: accepted, with and without a reason`, () => {
      expect(
        validateAnswerAgainstAsk(ask, {
          type: "declined",
          reason: "  not now ",
        })
      ).toEqual({ ok: true, value: { type: "declined", reason: "not now" } });
      // A blank reason is no reason (never stored as "").
      expect(
        validateAnswerAgainstAsk(ask, { type: "declined", reason: "   " })
      ).toEqual({ ok: true, value: { type: "declined" } });
      expect(validateAnswerAgainstAsk(ask, { type: "declined" })).toEqual({
        ok: true,
        value: { type: "declined" },
      });
    });
  }

  it("act still refuses every OTHER value (the exception is only the refusal)", () => {
    const act = ASKS.find(([n]) => n === "act")![1];
    expect(resolveAskResolution(act)).toBe("attest");
    expect(
      validateAnswerAgainstAsk(act, { type: "text" }, "done")
    ).toMatchObject({
      ok: false,
      code: "wrong_door",
    });
  });

  it("the wire parses the arm and bounds the reason", () => {
    expect(
      AskAnswerValueSchema.parse({ type: "declined", reason: "no" })
    ).toEqual({ type: "declined", reason: "no" });
    expect(AskAnswerValueSchema.parse({ type: "declined" })).toEqual({
      type: "declined",
    });
    expect(
      AskAnswerValueSchema.safeParse({
        type: "declined",
        reason: "x".repeat(ASK_LIMITS.answerTextMaxChars + 1),
      }).success
    ).toBe(false);
  });
});

describe("a refusal reads as a refusal, in words and to every reader", () => {
  it("summary: the vocabulary's past verb, then the reason", () => {
    const past = resolveActionLabel("refuse", "past");
    expect(past).toBe("Refused");
    for (const [, ask] of ASKS) {
      expect(summarizeAnswer(ask, { type: "declined" })).toBe(past);
      expect(
        summarizeAnswer(ask, { type: "declined", reason: "Use the EU key" })
      ).toBe(`${past}: Use the EU key`);
    }
    expect(ASK_COPY.refusedReceipt("Use the EU key")).toBe(
      declinedAnswerText("Use the EU key")
    );
  });

  it("the stored-answer readers see it, and nothing else as it", () => {
    const answer = {
      text: "Refused: no",
      value: { type: "declined", reason: "no" },
    };
    expect(isDeclinedAnswer(answer)).toBe(true);
    expect(declinedReasonOf(answer)).toBe("no");
    expect(isDeclinedValue(answer.value)).toBe(true);
    expect(
      isDeclinedAnswer({
        text: "No",
        value: { type: "confirm", confirmed: false },
      })
    ).toBe(false);
    expect(isDeclinedAnswer({ text: "x" })).toBe(false);
    expect(isDeclinedAnswer(null)).toBe(false);
    expect(
      declinedReasonOf({ value: { type: "declined", reason: "  " } })
    ).toBeNull();
  });

  it("the snapshot records no pick and no overruled advice", () => {
    const ask: Ask = {
      mode: "choose",
      options: [{ label: "EU", recommended: true }, { label: "US" }],
    } as Ask;
    const snap = buildAskSnapshot(ask, { type: "declined" });
    expect(snap.chosenKey).toBeNull();
    // Refusing is not "chose differently from the AI".
    expect(snap.followedRecommendation).toBeNull();
  });

  it("the deliverable says it is blocked on the refusal, with the reason", () => {
    expect(
      deliverableUnitInput(
        {
          kind: "doc",
          answer: {
            text: "x",
            value: { type: "declined", reason: "Wrong repo" },
          },
        },
        { sessionTerminal: true }
      )
    ).toEqual({ blockedBy: "Refused: Wrong repo" });
  });
});

describe("the card offers Refuse on every ask", () => {
  for (const [name, ask] of ASKS) {
    it(`${name}: Refuse, its reason field and what it does`, () => {
      const view = askCardView({ label: "GitHub token", owner: "human", ask });
      expect(view.refuse).toEqual({
        label: resolveActionLabel("refuse", "imperative"),
        reasonLabel: ASK_COPY.refuseReason,
        consequence: ASK_COPY.refuseConsequence,
      });
      expect(view.refuse.label).toBe("Refuse");
    });
  }
});
