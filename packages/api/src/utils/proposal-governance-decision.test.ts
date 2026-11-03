/**
 * WHY A PROPOSED WRITE ASKED — the stored marker's two ends: what the gate
 * stores from a resolution (`storedGovernanceDecisionOf`) and what the review
 * row serves from it (`readStoredGovernanceDecision` → `askedByFor`). Driven
 * from the resolution shape the resolver returns, through the stored JSON, to
 * the served field, with nothing hand-built between them.
 */
import { describe, it, expect } from "vitest";
import {
  GOVERNANCE_DECISION_KEY,
  askedByFor,
  readStoredGovernanceDecision,
  storedGovernanceDecisionOf,
} from "./proposal-governance-decision.js";

const COMPUTER = "2dca1bb4-0000-4000-8000-000000000001";
const RULE = "2dca1bb4-0000-4000-8000-000000000002";
const MAC = new Map([[COMPUTER, { id: COMPUTER, name: "MacBook" }]]);
const RULES = new Map([[RULE, { id: RULE, targetPattern: "entity.create" }]]);

/** Through the stored JSON, as the proposals row keeps it. */
const roundTrip = (marker: unknown) =>
  readStoredGovernanceDecision(
    JSON.parse(JSON.stringify({ [GOVERNANCE_DECISION_KEY]: marker }))
  );

describe("the computer that made a write ask reaches the card", () => {
  it("a propose the computer's pass decided: stored, read back, named", () => {
    const stored = storedGovernanceDecisionOf({
      decision: "propose",
      reasonCode: "HOST_ASKS_FIRST",
      governanceRuleId: RULE,
      decidedBy: { principal: "computer", computerUserId: COMPUTER },
    });
    expect(stored).toEqual({
      principal: "computer",
      computerUserId: COMPUTER,
      governanceRuleId: RULE,
    });
    expect(askedByFor(roundTrip(stored), MAC, RULES)).toEqual({
      principal: "computer",
      computer: { id: COMPUTER, name: "MacBook" },
      governanceRule: { id: RULE, targetPattern: "entity.create" },
    });
  });

  it("the agent's own propose rule is named, with no computer", () => {
    const stored = storedGovernanceDecisionOf({
      decision: "propose",
      reasonCode: "GOVERNANCE_RULE",
      governanceRuleId: RULE,
      decidedBy: { principal: "agent" },
    });
    expect(askedByFor(roundTrip(stored), MAC, RULES)).toEqual({
      principal: "agent",
      governanceRule: { id: RULE, targetPattern: "entity.create" },
    });
  });

  it("nothing to name stores nothing: no rule, no computer, or not a propose", () => {
    expect(
      storedGovernanceDecisionOf({
        decision: "propose",
        reasonCode: "WRITES_REQUIRE_PROPOSAL",
        decidedBy: { principal: "agent" },
      })
    ).toBeUndefined();
    expect(
      storedGovernanceDecisionOf({
        decision: "execute",
        governanceRuleId: RULE,
        decidedBy: { principal: "computer", computerUserId: COMPUTER },
      })
    ).toBeUndefined();
  });

  it("a rule or computer the viewer cannot see is left out, never an id", () => {
    const stored = {
      principal: "computer" as const,
      computerUserId: COMPUTER,
      governanceRuleId: RULE,
    };
    expect(askedByFor(stored, new Map(), new Map())).toEqual({
      principal: "computer",
    });
  });

  it("a malformed marker reads as absent", () => {
    for (const bad of [
      null,
      "computer",
      { principal: "someone" },
      { principal: "computer" },
      { principal: "computer", computerUserId: "not-a-uuid" },
    ]) {
      expect(roundTrip(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(readStoredGovernanceDecision(undefined)).toBeUndefined();
  });
});
