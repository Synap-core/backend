import { describe, expect, it } from "vitest";
import {
  checkCriterionMeaning,
  CRITERION_CHECK_MEANINGS,
} from "../units/index.js";
import {
  checkKindFor,
  criterionKeyOf,
  goalCriteriaInput,
  goalCriteriaInputCheck,
  goalCriterionInput,
} from "./criteria-input.js";

describe("goalCriterionInput — what a New goal form sends", () => {
  it("a measured criterion is checked by evidence posted under its own key", () => {
    expect(
      goalCriterionInput({
        statement: "Median wait < 20 min",
        meaning: "measured",
      })
    ).toEqual({
      key: "median-wait-20-min",
      statement: "Median wait < 20 min",
      required: true,
      check: { kind: "evidence", evidenceKey: "median-wait-20-min" },
      checkKind: "measured",
    });
  });

  it("every other meaning is a person’s check — handed over too, though evidence could carry it", () => {
    for (const m of [
      "judged",
      "handed_over",
      "decided_outside",
      "certified",
      "learning",
    ] as const) {
      expect(checkKindFor(m), m).toBe("human");
    }
    expect(
      goalCriterionInput({ statement: "Deck sent", meaning: "handed_over" })
        .check
    ).toEqual({ kind: "human" });
  });

  it("learning is about the method (R7)", () => {
    expect(
      goalCriterionInput({
        statement: "Three causes tested",
        meaning: "learning",
      }).about
    ).toBe("method");
    expect(
      goalCriterionInput({
        statement: "Three causes tested",
        meaning: "judged",
      })
    ).not.toHaveProperty("about");
  });

  it("every meaning builds a criterion the pod’s own meaning rule accepts", () => {
    for (const meaning of CRITERION_CHECK_MEANINGS) {
      expect(
        checkCriterionMeaning(goalCriterionInput({ statement: "x", meaning })),
        meaning
      ).toBeNull();
    }
  });

  it("keys are slugs, unique within the list; a kept key stays when it is a slug", () => {
    expect(criterionKeyOf("Léa reviewed the deck!")).toBe(
      "lea-reviewed-the-deck"
    );
    expect(criterionKeyOf("  ")).toBe("criterion");
    const list = goalCriteriaInput([
      { statement: "Ship it", meaning: "judged" },
      { statement: "Ship it", meaning: "judged" },
      { statement: "Ship it", meaning: "judged", key: "ship-it" },
    ]);
    expect(list.map((c) => c.key)).toEqual([
      "ship-it",
      "ship-it-2",
      "ship-it-3",
    ]);
    expect(
      goalCriterionInput({
        statement: "A",
        meaning: "judged",
        key: "kept.key_1",
      }).key
    ).toBe("kept.key_1");
    expect(
      goalCriterionInput({
        statement: "Bad one",
        meaning: "judged",
        key: "Bad Key",
      }).key
    ).toBe("bad-one");
  });
});

describe("goalCriteriaInputCheck — the 0-or-2–5 rule, before sending", () => {
  const n = (count: number) =>
    goalCriteriaInput(
      Array.from({ length: count }, (_, i) => ({
        statement: `c${i}`,
        meaning: "judged" as const,
      }))
    );

  it("no criteria (a lasting goal) and 2 to 5 pass; 1 and 6 are refused in the pod’s words", () => {
    expect(goalCriteriaInputCheck([])).toBeNull();
    expect(goalCriteriaInputCheck(n(2))).toBeNull();
    expect(goalCriteriaInputCheck(n(5))).toBeNull();
    expect(goalCriteriaInputCheck(n(1))).toMatch(/2 to 5/);
    expect(goalCriteriaInputCheck(n(6))).toMatch(/not 6/);
  });

  it("a criterion with no words is refused", () => {
    const list = n(2);
    list[1] = { ...list[1]!, statement: "  " };
    expect(goalCriteriaInputCheck(list)).toBe("Every criterion needs words.");
  });
});
