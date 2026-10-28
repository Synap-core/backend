import { describe, expect, it } from "vitest";
import { deriveGovernanceGrantOptions } from "@synap-core/types";
import {
  HAND_OFF_ACTION,
  handOffRuleFor,
  isHandOffRule,
} from "./hand-off-rule";

describe("the always-allow-hand-offs rule (B-3)", () => {
  it("is exactly the derivation's 'this agent' rule for a hand-off", () => {
    const derived = deriveGovernanceGrantOptions(
      {
        proposalId: "11111111-1111-4111-8111-111111111111",
        agentUserId: "agent-1",
        actionKey: HAND_OFF_ACTION,
      },
      "operator-any"
    ).find((o) => o.id === "agent")?.rule;
    const ours = handOffRuleFor(
      "agent-1",
      "11111111-1111-4111-8111-111111111111"
    );
    // The derivation spells an absent workspace as an undefined key.
    expect({ ...derived, workspaceId: undefined }).toEqual({
      ...ours,
      workspaceId: undefined,
    });
  });

  it("recognises its own rows, and only them", () => {
    const row = {
      id: "r1",
      agentLabel: "Claude Code",
      ...handOffRuleFor("agent-1"),
      agentUserId: "agent-1",
    };
    expect(isHandOffRule(row)).toBe(true);
    expect(isHandOffRule({ ...row, targetPattern: "*" })).toBe(false);
    expect(isHandOffRule({ ...row, principalKind: "any" })).toBe(false);
  });
});
