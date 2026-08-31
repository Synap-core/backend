import { describe, expect, it } from "vitest";
import { deriveAgentProposalSessionGoal } from "@synap/database";

describe("deriveAgentProposalSessionGoal", () => {
  it("prefers data.summary", () => {
    expect(
      deriveAgentProposalSessionGoal({
        data: { summary: "SCF prospecting batch" },
        proposalType: "entity.create",
        targetType: "entity",
      })
    ).toBe("SCF prospecting batch");
  });

  it("falls back to type · target", () => {
    expect(
      deriveAgentProposalSessionGoal({
        proposalType: "entity.update",
        targetType: "entity",
      })
    ).toBe("Agent entity.update · entity");
  });
});
