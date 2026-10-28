import { describe, expect, it } from "vitest";
import type { Ask } from "../ask/index.js";
import { isCriterionGradeAsk } from "./criterion-slot.js";

const gradeOptions = [
  { label: "Pass", value: "pass" },
  { label: "Fail", value: "fail" },
];
const grade: Ask = { mode: "choose", options: gradeOptions };

describe("isCriterionGradeAsk — a criterion slot drawn as its grade", () => {
  it("the escalated criterion's own ask (Pass / Fail) is a grade", () => {
    expect(isCriterionGradeAsk(grade)).toBe(true);
  });
  it("a grade read off the label only when it IS the verdict (wrong rule: case-folding the label)", () => {
    // The answer door reads `value ?? label` verbatim: a "Pass" label with no
    // value grades nothing, so it must not be drawn as a grade.
    expect(
      isCriterionGradeAsk({
        mode: "choose",
        options: [{ label: "Pass" }, { label: "Fail" }],
      })
    ).toBe(false);
    expect(
      isCriterionGradeAsk({
        mode: "choose",
        options: [{ label: "pass" }, { label: "fail" }],
      })
    ).toBe(true);
  });
  it("one option that is not a verdict makes it not a grade (wrong rule: any option matches)", () => {
    expect(
      isCriterionGradeAsk({
        mode: "choose",
        options: [...gradeOptions, { label: "Skip", value: "skip" }],
      })
    ).toBe(false);
  });
  it("free text, another mode or no ask is not a grade", () => {
    expect(
      isCriterionGradeAsk({
        mode: "choose",
        options: gradeOptions,
        allowOther: true,
      })
    ).toBe(false);
    expect(isCriterionGradeAsk({ mode: "act", steps: ["Check it"] })).toBe(
      false
    );
    expect(isCriterionGradeAsk({ mode: "confirm" })).toBe(false);
    expect(isCriterionGradeAsk(null)).toBe(false);
    expect(isCriterionGradeAsk(undefined)).toBe(false);
  });
});
