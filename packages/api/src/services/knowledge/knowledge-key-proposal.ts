/**
 * The row reads/writes the `knowledgeKey/create` approve executor
 * (`routers/proposals/executors/knowledge-key.ts`, S6) needs, kept OUT of
 * `routers/**` (the access-layer lint forbids raw scoped-table access there,
 * and its allowlist may only shrink) — the same split as
 * `services/views/view-content-proposal.ts`.
 */

import { db, and, eq, proposals, ProposalStatus } from "@synap/database";

/** Has this proposal already been approved (a retried / double approval)? */
export async function isKnowledgeKeyProposalApproved(
  proposalId: string
): Promise<boolean> {
  const [row] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId));
  return row?.status === ProposalStatus.APPROVED;
}

/** Marks a still-PENDING knowledge-key proposal APPROVED by `userId`. */
export async function markKnowledgeKeyProposalApproved(
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
