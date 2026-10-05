import { describe, expect, it } from "vitest";
import {
  OUTPUT_RETIRED_REASON_LABELS,
  resolveRetiredReasonLabel,
} from "./index.js";

describe("resolveRetiredReasonLabel", () => {
  it("labels both retire reasons", () => {
    expect(resolveRetiredReasonLabel("session_cancelled")).toBe(
      "Session cancelled"
    );
    expect(resolveRetiredReasonLabel("decision_resolved")).toBe(
      "Decided elsewhere"
    );
  });

  it("humanizes an unknown value instead of leaking it, and blanks absence", () => {
    expect(resolveRetiredReasonLabel("budget_exhausted")).toBe(
      "Budget exhausted"
    );
    expect(resolveRetiredReasonLabel(null)).toBe("");
    expect(Object.keys(OUTPUT_RETIRED_REASON_LABELS).length).toBeGreaterThan(0);
  });
});
