/**
 * The REASON for an agent-proposed row whose `data.sourceId` is the human.
 *
 * An agent key writes with its human's user id, so the canonical
 * `createProposal` stamps `data.sourceId = <human>` and `agentUserId = <agent>`.
 * The direct sourceId match then admitted the human as "owner", and the
 * proposal page read "You proposed this." on a write the AGENT proposed. The
 * verdict was right; the narration was false. It is "agent-owner".
 */
import { describe, expect, it } from "vitest";
import {
  computeCanReviewApprovalFromFacts,
  type ReviewAuthorityFacts,
} from "../review-authority.js";

const HUMAN = "human-user-id";
const AGENT = "agent-user-id";

const facts = (over: Partial<ReviewAuthorityFacts> = {}): ReviewAuthorityFacts => ({
  policy: "owner_and_admins",
  memberRole: undefined,
  viewerIsAgent: false,
  viewerIsPodAdmin: false,
  agentCreatedByUserId: undefined,
  subjectSessionUnreadable: false,
  ...over,
});

describe("review reason — an agent's proposal is never 'You proposed this'", () => {
  for (const workspaceId of [null, "ws-1"]) {
    const where = workspaceId ? "workspace" : "pod-wide";

    it(`${where}: sourceId = the human + agentUserId set ⇒ agent-owner`, () => {
      const v = computeCanReviewApprovalFromFacts({
        proposal: { workspaceId, data: { sourceId: HUMAN }, agentUserId: AGENT },
        userId: HUMAN,
        purpose: "approve",
        facts: facts({ agentCreatedByUserId: HUMAN }),
      });
      expect(v).toEqual({ allowed: true, reason: "agent-owner" });
    });

    it(`${where}: the human's own proposal (no agent) stays owner`, () => {
      const v = computeCanReviewApprovalFromFacts({
        proposal: { workspaceId, data: { sourceId: HUMAN }, agentUserId: null },
        userId: HUMAN,
        purpose: "approve",
        facts: facts(),
      });
      expect(v).toEqual({ allowed: true, reason: "owner" });
    });
  }
});
