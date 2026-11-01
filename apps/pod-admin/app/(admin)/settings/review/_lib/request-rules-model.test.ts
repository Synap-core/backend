import { describe, expect, it } from "vitest";
import { requestRules, type RequestRuleRow } from "./request-rules-model";

const AGENT = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";

function row(over: Partial<RequestRuleRow>): RequestRuleRow {
  return {
    id: "r1",
    principalKind: "agent",
    agentUserId: AGENT,
    agentLabel: "Scout",
    scopeKind: "pod",
    targetKind: "action",
    targetPattern: "entity.update",
    verdict: "deny",
    sourceProposalId: REQUEST,
    ...over,
  };
}

describe("requestRules — the always and never a person set on a request", () => {
  it("lists a request's deny and auto, with the AI's name", () => {
    const rules = requestRules([
      row({ id: "never" }),
      row({ id: "always", verdict: "auto", targetPattern: "relation.create" }),
    ]);
    expect(rules.map((r) => [r.id, r.verdict, r.agent])).toEqual([
      ["never", "deny", "Scout"],
      ["always", "auto", "Scout"],
    ]);
  });

  it("names a change through the vocabulary, never as a raw key", () => {
    const [rule] = requestRules([row({})]);
    expect(rule.what).not.toContain("entity.update");
    expect(rule.what.length).toBeGreaterThan(0);
  });

  it("a tool rule names the tool", () => {
    const [rule] = requestRules([
      row({ targetKind: "capability", targetPattern: "messaging://unipile" }),
    ]);
    expect(rule.what).toBe("messaging://unipile");
  });

  it("leaves out what Settings did not get from a request", () => {
    expect(
      requestRules([
        // a settings mirror or posture row: no request behind it
        row({ sourceProposalId: null }),
        // a rule for every AI, not one
        row({ principalKind: "any", agentUserId: null }),
        // a rule that only asks: nothing to take back
        row({ verdict: "propose" }),
        // an always hand-off: the switch above already shows it
        row({
          verdict: "auto",
          targetPattern: "focus_session.assign_agent",
        }),
      ])
    ).toEqual([]);
  });
});
