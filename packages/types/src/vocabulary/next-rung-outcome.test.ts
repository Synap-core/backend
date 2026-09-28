import { describe, expect, it } from "vitest";
import { NEXT_RUNG_OUTCOMES } from "../trust-ladder/index.js";
import {
  NEXT_RUNG_OUTCOME_LABELS,
  resolveNextRungOutcomeLabel,
} from "./index.js";

describe("next-rung outcome words (one mark, every surface)", () => {
  it("names every outcome the leaf declares, plus the failure mark", () => {
    expect(NEXT_RUNG_OUTCOMES.length).toBeGreaterThan(0); // non-vacuity
    for (const o of NEXT_RUNG_OUTCOMES) {
      expect(NEXT_RUNG_OUTCOME_LABELS[o]).toMatch(/\S/);
    }
    expect(resolveNextRungOutcomeLabel("created")).toBe("Rule added");
    expect(resolveNextRungOutcomeLabel("already_covered")).toBe("Already a rule");
    expect(resolveNextRungOutcomeLabel("proposed")).toBe("Sent to the agent's owner");
    expect(resolveNextRungOutcomeLabel("failed")).toBe("Not saved");
  });

  it("an unknown outcome humanizes, never leaks the token", () => {
    expect(resolveNextRungOutcomeLabel("sent_elsewhere")).toBe("Sent elsewhere");
  });
});
