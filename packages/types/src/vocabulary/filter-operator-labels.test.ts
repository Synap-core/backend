import { describe, it, expect } from "vitest";
import {
  FILTER_OPERATOR_LABELS,
  DATE_FILTER_OPERATOR_LABELS,
  resolveFilterOperatorLabel,
} from "./index.js";
import { VIEW_FILTER_OPERATORS } from "../views/filters.js";

describe("view filter operator labels (vocabulary door)", () => {
  it("every canonical operator (derived from the grammar) is labelled", () => {
    expect(VIEW_FILTER_OPERATORS.length).toBeGreaterThanOrEqual(12); // non-vacuity
    expect(Object.keys(FILTER_OPERATOR_LABELS).sort()).toEqual(
      [...VIEW_FILTER_OPERATORS].sort()
    );
  });

  it("reads as words, never symbols", () => {
    for (const label of Object.values(FILTER_OPERATOR_LABELS)) {
      expect(label).toMatch(/^[a-z ]+$/);
    }
    expect(resolveFilterOperatorLabel("equals")).toBe("is");
    expect(resolveFilterOperatorLabel("not_equals")).toBe("is not");
    expect(resolveFilterOperatorLabel("not_contains")).toBe("does not contain");
    expect(resolveFilterOperatorLabel("in")).toBe("is any of");
    expect(resolveFilterOperatorLabel("not_in")).toBe("is none of");
    expect(resolveFilterOperatorLabel("greater_than")).toBe("is greater than");
  });

  it("date ranges read as time; other date operators read as usual", () => {
    expect(resolveFilterOperatorLabel("greater_than", "date")).toBe("is after");
    expect(resolveFilterOperatorLabel("less_than_or_equal", "date")).toBe(
      "is on or before"
    );
    expect(resolveFilterOperatorLabel("equals", "date")).toBe("is");
    expect(resolveFilterOperatorLabel("greater_than", "number")).toBe(
      "is greater than"
    );
    // Only range operators carry a date phrasing.
    for (const op of Object.keys(DATE_FILTER_OPERATOR_LABELS)) {
      expect(op).toMatch(/^(greater|less)_than/);
    }
  });

  it("an unknown operator humanizes, never leaks", () => {
    expect(resolveFilterOperatorLabel("starts_with")).toBe("Starts with");
    expect(resolveFilterOperatorLabel(null)).toBe("");
  });
});
