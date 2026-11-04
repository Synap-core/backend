/**
 * THE HOST PASS'S WORDS (`AgentPolicyInput.hostPass`). An agent on a computer
 * is judged as itself and as its computer; when the computer's OWN setting
 * (a `propose` rule, its rung-5 switch, the plain default) is what asks, the
 * proposal says so (`HOST_ASKS_FIRST`) instead of "one of your rules", and a
 * `propose` rule's id rides out so the card can name it. Only words and
 * attribution change: every verdict is the same as without `hostPass`.
 */
import { describe, it, expect } from "vitest";
import {
  DESTRUCTIVE_ACTIONS,
  PROPOSE_REASON,
  decideAgentPolicy,
  type AgentPolicyInput,
} from "./index.js";

const RULE = "11111111-1111-4111-8111-111111111111";

describe("the host pass", () => {
  it("a computer's `propose` rule says its computer asks first, and names the rule", () => {
    const input: AgentPolicyInput = {
      subjectType: "entity",
      action: "create",
      governanceRuleVerdict: "propose",
      governanceRuleId: RULE,
    };
    expect(decideAgentPolicy({ ...input, hostPass: true })).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.HOST_ASKS_FIRST,
      reasonCode: "HOST_ASKS_FIRST",
      governanceRuleId: RULE,
    });
    // The agent's own pass keeps its words, and names the rule too.
    expect(decideAgentPolicy(input)).toEqual({
      verdict: "propose",
      reason: PROPOSE_REASON.GOVERNANCE_RULE,
      reasonCode: "GOVERNANCE_RULE",
      governanceRuleId: RULE,
    });
  });

  it("the computer's rung-5 switch and the plain default say it too", () => {
    for (const input of [
      { subjectType: "entity", action: "update", writesRequireProposal: true },
      { subjectType: "widget", action: "frobnicate" },
    ] satisfies AgentPolicyInput[]) {
      const own = decideAgentPolicy(input);
      expect(own.verdict, input.action).toBe("propose");
      expect(decideAgentPolicy({ ...input, hostPass: true })).toMatchObject({
        verdict: "propose",
        reasonCode: "HOST_ASKS_FIRST",
      });
    }
  });

  it("a floor keeps its own words on the host side (both passes run every floor)", () => {
    const input: AgentPolicyInput = {
      subjectType: "entity",
      action: DESTRUCTIVE_ACTIONS[0]!,
      hostPass: true,
    };
    expect(decideAgentPolicy(input)).toMatchObject({
      verdict: "propose",
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    });
  });

  it("never changes a verdict: execute and deny pass through", () => {
    for (const input of [
      {
        subjectType: "entity",
        action: "update",
        governanceRuleVerdict: "auto",
        governanceRuleId: RULE,
      },
      {
        subjectType: "entity",
        action: "update",
        governanceRuleVerdict: "deny",
      },
    ] satisfies AgentPolicyInput[]) {
      expect(decideAgentPolicy({ ...input, hostPass: true })).toEqual(
        decideAgentPolicy(input)
      );
    }
  });
});
