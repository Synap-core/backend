import { describe, it, expect } from "vitest";
import { decideAgentPolicy, PROPOSE_REASON } from "./index.js";

/**
 * D6 — an AGENT defining a kind or role is ALWAYS a proposal: no rule,
 * ownership or autoApproveFor wildcard can widen it.
 *
 * Humans never reach `decideAgentPolicy` (the gate runs it only for an agent
 * principal or the anonymous-AI source path), so "a human create is unchanged"
 * is a property of the CALLER, not something this pure engine can witness.
 */

const FLOORED = {
  verdict: "propose",
  reason: PROPOSE_REASON.AGENT_SCHEMA_DEFINITION,
  reasonCode: "AGENT_SCHEMA_DEFINITION",
} as const;

describe("rung 2.08 — agent-defined schema floor (D6)", () => {
  it("an agent profile.create proposes with no widening signal", () => {
    expect(
      decideAgentPolicy({ subjectType: "profile", action: "create" })
    ).toEqual(FLOORED);
  });

  it("a governance rule saying auto CANNOT widen it (rung 2.8)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "profile",
        action: "create",
        governanceRuleVerdict: "auto",
      })
    ).toEqual(FLOORED);
  });

  it("an agent-owned workspace CANNOT widen it (rung 3)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "profile",
        action: "create",
        isAgentOwnedWorkspace: true,
      })
    ).toEqual(FLOORED);
  });

  it("an autoApproveFor wildcard CANNOT widen it (rung 4), nor a trusted twin agent", () => {
    expect(
      decideAgentPolicy({
        subjectType: "profile",
        action: "create",
        autoApproveFor: ["profile.*", "*"],
        writesRequireProposal: false,
      })
    ).toEqual(FLOORED);
  });

  it("the plural spelling is floored too (the gate composes the RAW subjectType)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "profiles",
        action: "create",
        governanceRuleVerdict: "auto",
      })
    ).toEqual(FLOORED);
  });

  it("CBAC deny still wins above the floor (a denied agent is denied, not proposed)", () => {
    expect(
      decideAgentPolicy({
        subjectType: "profile",
        action: "create",
        agentCapabilities: ["entity.*"],
      }).verdict
    ).toBe("deny");
  });

  it("does not over-reach: profile.renderer.set and entity.create keep their verdicts", () => {
    expect(
      decideAgentPolicy({
        subjectType: "profile",
        action: "renderer.set",
        governanceRuleVerdict: "auto",
      })
    ).toEqual({ verdict: "execute" });
    expect(
      decideAgentPolicy({ subjectType: "entity", action: "create" })
    ).toEqual({ verdict: "execute" });
  });
});
