import { describe, expect, it } from "vitest";
import { GOVERNANCE_POLICY_SENTENCES } from "@synap-core/types/proposals";
import { proposalWhy } from "./proposal-why";

const WRITES = GOVERNANCE_POLICY_SENTENCES.WRITES_REQUIRE_PROPOSAL;

describe("proposalWhy", () => {
  it("names the policy from the stored code and keeps the proposer's own words", () => {
    expect(
      proposalWhy({
        governanceReason: "WRITES_REQUIRE_PROPOSAL",
        reasoning: "The client asked for a follow-up note.",
      })
    ).toEqual({
      policy: WRITES,
      proposer: "The client asked for a follow-up note.",
    });
  });

  it("never shows a legacy policy sentence as the proposer's reasoning", () => {
    expect(proposalWhy({ governanceReason: null, reasoning: WRITES })).toEqual({
      policy: WRITES,
      proposer: undefined,
    });
  });

  it("shows the sentence once when a legacy row carries both the code and the sentence", () => {
    expect(
      proposalWhy({
        governanceReason: "WRITES_REQUIRE_PROPOSAL",
        reasoning: `  ${WRITES}\n`,
      })
    ).toEqual({ policy: WRITES, proposer: undefined });
  });

  it("returns nothing for blank reasoning and unknown or prototype codes", () => {
    expect(
      proposalWhy({ governanceReason: "toString", reasoning: "  " })
    ).toEqual({ policy: undefined, proposer: undefined });
    expect(proposalWhy({ governanceReason: "NOT_A_CODE" })).toEqual({
      policy: undefined,
      proposer: undefined,
    });
  });
});
