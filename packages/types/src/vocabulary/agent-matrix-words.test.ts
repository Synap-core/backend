import { describe, expect, it } from "vitest";
import { GOVERNANCE_RUNGS } from "../agent-matrix/index.js";
import {
  GOVERNANCE_RUNG_LABELS,
  MATRIX_MARK_LABELS,
  resolveGovernanceRungLabel,
  resolveMatrixMarkLabel,
} from "./index.js";

describe("agent × work matrix words", () => {
  it("names every rung the contract lists, with words (never the token)", () => {
    expect(GOVERNANCE_RUNGS.length).toBeGreaterThanOrEqual(15); // non-vacuity
    for (const rung of GOVERNANCE_RUNGS) {
      const words = GOVERNANCE_RUNG_LABELS[rung];
      expect(words).toMatch(/\S/);
      expect(words).not.toBe(rung);
    }
    expect(resolveGovernanceRungLabel("governance-rule")).toBe("A rule");
    expect(resolveGovernanceRungLabel("cbac-capability-allowlist")).toBe(
      "Not in its tool list"
    );
  });

  it("an unknown rung humanizes, never leaks; no rung is no words", () => {
    expect(resolveGovernanceRungLabel("rung_9_9")).not.toContain("_");
    expect(resolveGovernanceRungLabel(null)).toBe("");
  });

  it("names the four marks", () => {
    expect(Object.keys(MATRIX_MARK_LABELS).sort()).toEqual([
      "ask",
      "auto",
      "mixed",
      "off",
    ]);
    expect(resolveMatrixMarkLabel("auto")).toBe("Acts");
    expect(resolveMatrixMarkLabel("mixed")).toBe("Mixed");
  });
});
