/**
 * The proposal-row reads/writes the `view/updateContent` approve executor
 * (`routers/proposals/executors/view.ts`) needs, kept OUT of `routers/**` (the
 * access-layer lint forbids raw scoped-table access there, and its allowlist
 * may only shrink). The executor stays the decision; these are its two row
 * touches — the same split as `services/trusted-issuers/scope-request-proposal.ts`.
 */

import { db, and, eq, proposals, ProposalStatus } from "@synap/database";

export async function isViewContentProposalApproved(
  proposalId: string
): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

/** Marks a still-PENDING view-content proposal APPROVED by `userId`. */
export async function markViewContentProposalApproved(
  proposalId: string,
  userId: string
): Promise<void> {
  await db
    .update(proposals)
    .set({
      status: ProposalStatus.APPROVED,
      reviewedBy: userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(proposals.id, proposalId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
}
