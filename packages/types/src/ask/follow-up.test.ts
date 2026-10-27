/**
 * The decision tree, ONE level (AffectUI): a choose option may open a
 * follow-up question; the answer records the path (`chip` → `then`); an ask
 * may carry a risk mark; an option may carry a caution.
 *
 * Each rule pairs the row that passes with its one-fact-away twin.
 */
import { describe, expect, it } from "vitest";
import {
  AskSchema,
  AskAnswerValueSchema,
  ASK_LIMITS,
  askAnswersInline,
  buildAskSnapshot,
  summarizeAnswer,
  validateAnswerAgainstAsk,
  type Ask,
} from "./index.js";
import { askOptionChips, askRiskView, followUpChips } from "./card.js";

const DEPLOY: Ask = AskSchema.parse({
  mode: "choose",
  risk: "high",
  options: [
    {
      label: "Ship it",
      recommended: true,
      caution: "Skips 1,284 tests",
      followUp: {
        prompt: "Which environment?",
        options: [
          { label: "Staging", recommended: true },
          { label: "Production", caution: "Live customers" },
        ],
      },
    },
    { label: "Wait" },
  ],
});

const choose = (options: unknown[], extra: Record<string, unknown> = {}) =>
  AskSchema.safeParse({ mode: "choose", options, ...extra });
const twoOptions = [{ label: "A" }, { label: "B" }];

describe("the parse: one level, bounded", () => {
  it("keeps a follow-up, a caution and a risk", () => {
    if (DEPLOY.mode !== "choose") throw new Error("choose");
    expect(DEPLOY.risk).toBe("high");
    expect(DEPLOY.options[0]!.caution).toBe("Skips 1,284 tests");
    expect(DEPLOY.options[0]!.followUp?.options).toHaveLength(2);
  });

  it("refuses a second level instead of stripping it", () => {
    const deep = choose([
      {
        label: "X",
        followUp: {
          prompt: "Then?",
          options: [
            {
              label: "A",
              followUp: { prompt: "Deeper?", options: twoOptions },
            },
            { label: "B" },
          ],
        },
      },
    ]);
    expect(deep.success).toBe(false);
    expect(JSON.stringify(deep.error?.issues)).toMatch(/one level deep/);
    expect(
      choose([
        { label: "X", followUp: { prompt: "Then?", options: twoOptions } },
      ]).success
    ).toBe(true);
  });

  it("a follow-up offers 2 to 4 options, at most one recommended", () => {
    const fu = (options: unknown[]) =>
      choose([{ label: "X", followUp: { prompt: "Then?", options } }]).success;
    expect(fu([{ label: "A" }])).toBe(false);
    expect(fu(twoOptions)).toBe(true);
    expect(
      fu(
        Array.from({ length: ASK_LIMITS.followUpOptionsMax + 1 }, (_, i) => ({
          label: `O${i}`,
        }))
      )
    ).toBe(false);
    expect(
      fu([
        { label: "A", recommended: true },
        { label: "B", recommended: true },
      ])
    ).toBe(false);
  });

  it("bounds the prompt and the caution; risk is a closed set", () => {
    const longPrompt = "x".repeat(ASK_LIMITS.followUpPromptMaxChars + 1);
    expect(
      choose([
        { label: "X", followUp: { prompt: longPrompt, options: twoOptions } },
      ]).success
    ).toBe(false);
    expect(
      choose([
        {
          label: "X",
          caution: "x".repeat(ASK_LIMITS.optionCautionMaxChars + 1),
        },
      ]).success
    ).toBe(false);
    expect(choose(twoOptions, { risk: "medium" }).success).toBe(true);
    expect(choose(twoOptions, { risk: "extreme" }).success).toBe(false);
    expect(AskSchema.safeParse({ mode: "confirm", risk: "low" }).success).toBe(
      true
    );
  });
});

describe("the answer: the path through the tree", () => {
  const chip = (label: string, then?: string) =>
    AskAnswerValueSchema.parse({
      type: "chip",
      chip: { label },
      ...(then ? { then: { label: then } } : {}),
    });

  it("an option that opens a follow-up needs its pick, from its own options", () => {
    const ok = validateAnswerAgainstAsk(DEPLOY, chip("Ship it", "Staging"));
    expect(ok.ok).toBe(true);
    if (!ok.ok || ok.value.type !== "chip") throw new Error("chip");
    // The OFFERED options are stored, flat: no follow-up rides on the chip.
    expect(ok.value.chip).toEqual({
      label: "Ship it",
      recommended: true,
      caution: "Skips 1,284 tests",
    });
    expect(ok.value.then).toEqual({ label: "Staging", recommended: true });

    const missing = validateAnswerAgainstAsk(DEPLOY, chip("Ship it"));
    expect(missing).toMatchObject({ ok: false, code: "follow_up_required" });
    const foreign = validateAnswerAgainstAsk(DEPLOY, chip("Ship it", "Wait"));
    expect(foreign).toMatchObject({ ok: false, code: "not_offered" });
  });

  it("an option that opens none takes no `then`", () => {
    expect(validateAnswerAgainstAsk(DEPLOY, chip("Wait")).ok).toBe(true);
    expect(
      validateAnswerAgainstAsk(DEPLOY, chip("Wait", "Staging"))
    ).toMatchObject({ ok: false, code: "not_offered" });
  });

  it("the receipt reads the path; the snapshot records it", () => {
    const v = chip("Ship it", "Production");
    expect(summarizeAnswer(DEPLOY, v, "after lunch")).toBe(
      "Ship it → Production — after lunch"
    );
    expect(summarizeAnswer(DEPLOY, chip("Wait"))).toBe("Wait");
    const snap = buildAskSnapshot(DEPLOY, v);
    expect(snap).toMatchObject({ chosenKey: "Ship it", thenKey: "Production" });
    expect(snap.options?.[0]?.followUp?.prompt).toBe("Which environment?");
    expect("thenKey" in buildAskSnapshot(DEPLOY, chip("Wait"))).toBe(false);
  });
});

describe("the card", () => {
  it("draws high and medium risk, nothing for low or none", () => {
    expect(askRiskView(DEPLOY)).toEqual({
      level: "high",
      label: "High risk",
      tone: "danger",
    });
    expect(askRiskView({ risk: "medium" })?.tone).toBe("warning");
    expect(askRiskView({ risk: "low" })).toBeNull();
    expect(askRiskView({})).toBeNull();
  });

  it("carries the caution, and the second level through followUpChips", () => {
    if (DEPLOY.mode !== "choose") throw new Error("choose");
    expect(askOptionChips(DEPLOY)[0]).toMatchObject({
      label: "Ship it",
      caution: "Skips 1,284 tests",
    });
    expect(followUpChips(DEPLOY.options[0]!).map((c) => c.value)).toEqual([
      "Staging",
      "Production",
    ]);
    expect(followUpChips(DEPLOY.options[1]!)).toEqual([]);
  });
});

describe("a tree is never answered in the row", () => {
  it("a choose with a follow-up is not inline; its flat twin is", () => {
    expect(askAnswersInline(DEPLOY)).toBe(false);
    expect(
      askAnswersInline(AskSchema.parse({ mode: "choose", options: twoOptions }))
    ).toBe(true);
  });
});
