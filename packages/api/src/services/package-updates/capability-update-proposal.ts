/**
 * The row reads/writes the `capability/capability.update` approve executor
 * (`routers/proposals/executors/package-update.ts`) needs, kept OUT of
 * `routers/**` (the access-layer lint forbids raw scoped-table access there,
 * and its allowlist may only shrink). The executor stays the decision; these
 * are its row touches — the same split as
 * `services/views/view-content-proposal.ts`.
 */

import {
  db,
  and,
  eq,
  proposals,
  ProposalStatus,
  transitionProposal,
} from "@synap/database";

/** Has this proposal already been approved (a retried / double approval)? */
export async function isCapabilityUpdateProposalApproved(
  proposalId: string
): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

/** Marks a still-PENDING capability-update proposal APPROVED by `userId`. */
export async function markCapabilityUpdateProposalApproved(
  proposalId: string,
  userId: string
): Promise<void> {
  await transitionProposal(db, {
    to: ProposalStatus.APPROVED,
    set: {
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    },
    where: and(
      eq(proposals.id, proposalId),
      eq(proposals.status, ProposalStatus.PENDING)
    ),
  });
}
