/**
 * The ONE mark a review card draws for WHY a write waits: a reason's short
 * label, its sentence behind it. Every engine code has both (the type makes a
 * missing label a compile error; this pins the words a reviewer reads), and a
 * stored text that is not a code draws no mark.
 */
import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_POLICY_SENTENCES,
  GOVERNANCE_REASON_SHORT_LABELS,
  governanceReasonMark,
} from "../governance-policy-sentences.js";

describe("governanceReasonMark", () => {
  it("a duplicate reads as the reason, not as the ladder's reach", () => {
    expect(governanceReasonMark("POSSIBLE_DUPLICATE")).toEqual({
      code: "POSSIBLE_DUPLICATE",
      label: "Possible duplicate",
      sentence: GOVERNANCE_POLICY_SENTENCES.POSSIBLE_DUPLICATE,
    });
  });

  it("every code is classified: a few words, or explicitly no mark", () => {
    expect(Object.keys(GOVERNANCE_REASON_SHORT_LABELS).sort()).toEqual(
      Object.keys(GOVERNANCE_POLICY_SENTENCES).sort()
    );
    for (const label of Object.values(GOVERNANCE_REASON_SHORT_LABELS)) {
      if (label === null) continue;
      expect(label.split(" ").length, label).toBeLessThanOrEqual(5);
      expect(label, label).not.toMatch(/[.,;]$/);
    }
  });

  it("a reason that only says 'this waits for you' draws no mark", () => {
    // The default, a rule of yours that asks, a human gate: a pending
    // proposal already waits on the person.
    for (const code of [
      "WRITES_REQUIRE_PROPOSAL",
      "GOVERNANCE_RULE",
      "HUMAN_GATE",
    ]) {
      expect(governanceReasonMark(code), code).toBeNull();
    }
    // …while a reason about THIS change keeps its mark.
    expect(governanceReasonMark("DESTRUCTIVE_HARD_FLOOR")?.label).toBe(
      "Removes something"
    );
  });

  it("absent, unknown and inherited names draw no mark", () => {
    expect(governanceReasonMark(null)).toBeNull();
    expect(governanceReasonMark("")).toBeNull();
    expect(governanceReasonMark("NOT_A_CODE")).toBeNull();
    expect(governanceReasonMark("toString")).toBeNull();
  });
});
