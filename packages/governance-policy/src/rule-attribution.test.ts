/**
 * Rung 2.8 ATTRIBUTION — the `execute` verdict names the governance_rules row
 * only when rung 2.8 is the rung that decided. Additive: every verdict here is
 * the one the ladder gave before `governanceRuleId` existed.
 */
import { describe, it, expect } from "vitest";
import { decideAgentPolicy } from "./index.js";

const base = { subjectType: "entity", action: "update" } as const;

describe("decideAgentPolicy — governanceRuleId", () => {
  it("an `auto` rule that decides carries its id on the execute verdict", () => {
    expect(
      decideAgentPolicy({
        ...base,
        governanceRuleVerdict: "auto",
        governanceRuleId: "rule-1",
      })
    ).toEqual({ verdict: "execute", governanceRuleId: "rule-1" });
  });

  it("no rule ⇒ rung 8 decides, byte-identical, no id", () => {
    expect(decideAgentPolicy({ ...base, governanceRuleId: "rule-1" })).toEqual({
      verdict: "execute",
    });
  });

  it("a floor above rung 2.8 wins and names no rule (delete stays propose)", () => {
    const verdict = decideAgentPolicy({
      subjectType: "entity",
      action: "delete",
      governanceRuleVerdict: "auto",
      governanceRuleId: "rule-1",
    });
    expect(verdict.verdict).toBe("propose");
    expect(verdict).not.toHaveProperty("governanceRuleId");
  });

  it("a `propose` rule stays propose and names no rule on the verdict", () => {
    const verdict = decideAgentPolicy({
      ...base,
      governanceRuleVerdict: "propose",
      governanceRuleId: "rule-1",
    });
    expect(verdict.verdict).toBe("propose");
    expect(verdict).not.toHaveProperty("governanceRuleId");
  });
});
