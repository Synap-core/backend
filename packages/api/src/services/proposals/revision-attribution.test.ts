import { describe, it, expect } from "vitest";
import { computeRevisedEnvelope } from "./proposals-service.js";
import { computeAgentScorecard } from "../diagnose/agent-scorecard.js";

/**
 * SEAM (B21): the revision entry the shared revise core WRITES is the one the
 * agent scorecard READS. Nothing is hand-built between the two — deleting the
 * attribution projection in `computeRevisedEnvelope` must fail this test even
 * though the scorecard's own unit test (which hand-builds entries) stays green.
 */

function scoredRevised(revision: unknown): number {
  return computeAgentScorecard(
    [
      {
        proposalType: "create",
        targetType: "entity",
        targetId: "t1",
        data: {},
        status: "pending",
        rejectionReason: null,
        reasonCode: null,
        revisionHistory: [revision as never],
        createdAt: new Date("2026-09-13T00:00:00Z"),
        workspaceId: "ws1",
      },
    ],
    {
      agentId: "agent-1",
      agentName: null,
      agentType: null,
      pendingCount: 0,
      cap: 10,
    }
  ).counts.revised;
}

describe("revision attribution → scorecard", () => {
  it("an agent-key revise (recorded under its human owner) is NOT a human correction", () => {
    const { revision } = computeRevisedEnvelope({
      envelope: { summary: "old" },
      summary: "rewritten from a room comment",
      actorId: "human-1",
      actingAgentUserId: "agent-1",
    });
    expect(revision).toMatchObject({
      by: "human-1",
      actingAgentUserId: "agent-1",
    });
    expect(scoredRevised(revision)).toBe(0);
  });

  it("a human revise IS a human correction", () => {
    const { revision } = computeRevisedEnvelope({
      envelope: { summary: "old" },
      summary: "fixed by hand",
      actorId: "human-1",
    });
    expect(revision).not.toHaveProperty("actingAgentUserId");
    expect(scoredRevised(revision)).toBe(1);
  });
});
