/**
 * THE REJECT BAR IS THE APPROVE BAR — for a HUMAN viewer.
 *
 * `proposals.list` ships ONE flag per row, `viewerCanReview`, computed with
 * `purpose: "approve"` (routers/proposals.ts, the list block). The browser's
 * "Your turn" gates BOTH Approve and Reject on it (`SessionYourTurn.tsx`,
 * `row.canApprove`). That is correct only while, for a human, the reject
 * ladder admits exactly whom the approve ladder admits: otherwise a person who
 * may reject would be shown no Reject button, with nothing to explain why.
 *
 * The ladder's ONE purpose-dependent rung is the agent-class floor
 * (`purpose === "approve" && viewerIsAgent`). This test walks every fact
 * combination the pure ladder reads and asserts the two purposes agree for
 * every human, and — the discriminating rows — that they DISAGREE for an
 * agent, so a scan that stopped exercising the one differing rung fails.
 *
 * What it does NOT cover, measured: the RESOLVERS (`resolveReviewAuthorityFacts`
 * vs the list's batched resolver) feeding the ladder; it takes the facts as
 * given. The two resolvers' agreement is `list-viewer-can-review-one-ladder`.
 */

import { describe, expect, it } from "vitest";
import {
  computeCanReviewApprovalFromFacts,
  type ProposalApprovalPolicy,
  type ReviewAuthorityFacts,
} from "../review-authority.js";

const VIEWER = "user-viewer";
const OTHER = "user-other";
const AGENT = "agent-1";

const POLICIES: ProposalApprovalPolicy[] = ["admins_only", "any_editor", "owner_and_admins"];
const ROLES = [undefined, "viewer", "editor", "admin", "owner"];
const OWNER_OF_AGENT = [undefined, null, VIEWER, OTHER] as const;
const PROPOSALS = [
  { workspaceId: "ws-1", data: { sourceId: VIEWER }, agentUserId: null },
  { workspaceId: "ws-1", data: { sourceId: OTHER }, agentUserId: AGENT },
  { workspaceId: "ws-1", data: {}, agentUserId: null },
  { workspaceId: null, data: { sourceId: VIEWER }, agentUserId: null },
  { workspaceId: null, data: { sourceId: OTHER }, agentUserId: AGENT },
];

function* allFacts(viewerIsAgent: boolean): Generator<ReviewAuthorityFacts> {
  for (const policy of POLICIES)
    for (const memberRole of ROLES)
      for (const viewerIsPodAdmin of [false, true])
        for (const agentCreatedByUserId of OWNER_OF_AGENT)
          for (const subjectSessionUnreadable of [false, true])
            yield {
              policy,
              memberRole,
              viewerIsAgent,
              viewerIsPodAdmin,
              agentCreatedByUserId,
              subjectSessionUnreadable,
            };
}

const verdict = (
  proposal: (typeof PROPOSALS)[number],
  facts: ReviewAuthorityFacts,
  purpose: "approve" | "reject",
) => computeCanReviewApprovalFromFacts({ proposal, userId: VIEWER, purpose, facts }).allowed;

describe("reject authority == approve authority for a human viewer", () => {
  it("every fact combination agrees, and the walk admits AND refuses someone", () => {
    let checked = 0;
    let allowed = 0;
    for (const proposal of PROPOSALS) {
      for (const facts of allFacts(false)) {
        const approve = verdict(proposal, facts, "approve");
        expect(verdict(proposal, facts, "reject"), JSON.stringify({ proposal, facts })).toBe(
          approve,
        );
        checked++;
        if (approve) allowed++;
      }
    }
    // Non-vacuity: a walk where everyone is refused (or admitted) agrees trivially.
    expect(checked).toBe(PROPOSALS.length * 3 * 5 * 2 * 4 * 2);
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThan(checked);
  });

  it("the walk can SEE the one purpose-dependent rung: an agent diverges", () => {
    let diverged = 0;
    for (const proposal of PROPOSALS) {
      for (const facts of allFacts(true)) {
        if (verdict(proposal, facts, "approve") !== verdict(proposal, facts, "reject")) diverged++;
      }
    }
    expect(diverged).toBeGreaterThan(0);
  });
});
