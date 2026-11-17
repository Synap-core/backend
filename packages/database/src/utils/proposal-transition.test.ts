/**
 * The proposal transition table: how a FAILED approval may end.
 *
 * Plan 8032a127 D2 (founder, 17 Nov 2026): 44 `approval_failed` rows on the
 * founder's pod could leave only through a person's reject, which scores
 * against the agent. A failed proposal now ends like a pending one, with no
 * new status: withdrawn (its author took it back, or a newer filing replaced
 * it) or expired (its moment passed, its record landed). Both are final.
 */
import { describe, it, expect } from "vitest";
import {
  PROPOSAL_TRANSITIONS,
  canTransitionProposal,
  proposalStatusesThatMayBecome,
  UNDECIDED_PROPOSAL_STATUSES,
} from "./proposal-transition.js";
import { ProposalStatus } from "../schema/proposals.js";

describe("a failed approval can end without a person deciding", () => {
  it("approval_failed may become withdrawn and expired", () => {
    expect(
      canTransitionProposal(
        ProposalStatus.APPROVAL_FAILED,
        ProposalStatus.WITHDRAWN
      )
    ).toBe(true);
    expect(
      canTransitionProposal(
        ProposalStatus.APPROVAL_FAILED,
        ProposalStatus.EXPIRED
      )
    ).toBe(true);
  });

  it("withdrawn and expired stay final", () => {
    expect(PROPOSAL_TRANSITIONS[ProposalStatus.WITHDRAWN]).toEqual([]);
    expect(PROPOSAL_TRANSITIONS[ProposalStatus.EXPIRED]).toEqual([]);
  });

  it("only the undecided statuses may end as withdrawn or expired", () => {
    for (const to of [ProposalStatus.WITHDRAWN, ProposalStatus.EXPIRED]) {
      expect(new Set(proposalStatusesThatMayBecome(to))).toEqual(
        new Set(UNDECIDED_PROPOSAL_STATUSES)
      );
    }
  });
});
