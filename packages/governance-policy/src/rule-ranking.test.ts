/**
 * THE ranking of approval rows for a tool run (finding ac28928c): the highest
 * rank decides (who + where + what), a tie goes to the stricter verdict.
 */
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_TARGET_SPECIFICITY,
  capabilityRuleRank,
  decidingCapabilityRule,
  verdictStrictness,
  type RuleVerdict,
} from "./rule-ranking.js";

const everyone = { principalKind: "any", scopeKind: "pod" } as const;
const agent = { principalKind: "agent", scopeKind: "pod" } as const;
const row = (verdict: RuleVerdict, id = verdict) => ({ id, verdict });

describe("decidingCapabilityRule — which row decides a tool run", () => {
  it("a tie between 'runs on its own' and 'asks first' asks first (the finding)", () => {
    const rank = capabilityRuleRank(everyone, "action");
    expect(
      decidingCapabilityRule([
        { rule: row("auto"), rank },
        { rule: row("propose"), rank },
      ])?.verdict
    ).toBe("propose");
    // Whatever the order the rows come in.
    expect(
      decidingCapabilityRule([
        { rule: row("propose"), rank },
        { rule: row("auto"), rank },
      ])?.verdict
    ).toBe("propose");
  });

  it("'never' wins any tie", () => {
    const rank = capabilityRuleRank(everyone, "tool");
    expect(
      decidingCapabilityRule([
        { rule: row("auto"), rank },
        { rule: row("deny"), rank },
        { rule: row("propose"), rank },
      ])?.verdict
    ).toBe("deny");
  });

  it("a row on the action outranks the tool's row, whatever its verdict", () => {
    expect(
      decidingCapabilityRule([
        { rule: row("deny"), rank: capabilityRuleRank(everyone, "tool") },
        { rule: row("auto"), rank: capabilityRuleRank(everyone, "action") },
      ])?.verdict
    ).toBe("auto");
  });

  it("one agent's row on the whole tool outranks every AI's row on the action", () => {
    expect(capabilityRuleRank(agent, "tool")).toBeGreaterThan(
      capabilityRuleRank(everyone, "action")
    );
  });

  it("a space outranks the pod; nothing matching decides nothing", () => {
    expect(
      capabilityRuleRank(
        { principalKind: "any", scopeKind: "workspace" },
        "tool"
      )
    ).toBeGreaterThan(capabilityRuleRank(everyone, "tool"));
    expect(decidingCapabilityRule([])).toBeUndefined();
  });

  it("pins the numbers the resolver ranks with", () => {
    expect(CAPABILITY_TARGET_SPECIFICITY).toEqual({ action: 3, tool: 2 });
    expect(
      ["auto", "propose", "deny"].map((v) =>
        verdictStrictness(v as RuleVerdict)
      )
    ).toEqual([0, 1, 2]);
  });
});
