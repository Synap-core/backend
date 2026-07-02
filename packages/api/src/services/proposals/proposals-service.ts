/**
 * Proposals service — shared data access behind the MCP proposal tools.
 *
 * The MCP handlers (`synap_list_proposals`, `synap_governance`,
 * `synap_revise_proposal`) delegate here so the adapter does ZERO bespoke DB
 * work. These preserve the adapter's exact, creator-scoped semantics — which
 * differ from the Hub `proposals` tRPC router (that one scopes by workspace
 * visibility, not `createdBy`, so it is NOT interchangeable here).
 */

import {
  db,
  proposals,
  ProposalStatus,
  eq,
  and,
  desc,
  drizzleSql,
} from "@synap/database";

/**
 * List proposals CREATED BY a user (optionally narrowed to a workspace/status),
 * newest first. `status` accepts the MCP arg strings — anything other than the
 * three known states (or "all") maps to PENDING, and "all" skips the filter.
 */
export async function listCreatedProposals(params: {
  createdBy: string;
  workspaceId?: string;
  status?: string;
  limit?: number;
}): Promise<Array<typeof proposals.$inferSelect>> {
  const statusArg = params.status || "pending";
  const statusMap: Record<string, ProposalStatus> = {
    pending: ProposalStatus.PENDING,
    approved: ProposalStatus.APPROVED,
    rejected: ProposalStatus.REJECTED,
  };
  const status = statusMap[statusArg] ?? ProposalStatus.PENDING;

  const conditions = [eq(proposals.createdBy, params.createdBy)];
  if (params.workspaceId)
    conditions.push(eq(proposals.workspaceId, params.workspaceId));
  if (statusArg !== "all") conditions.push(eq(proposals.status, status));

  return db
    .select()
    .from(proposals)
    .where(and(...conditions))
    .orderBy(desc(proposals.createdAt))
    .limit(params.limit ?? 20);
}

/** Count PENDING proposals in a workspace (all authors). */
export async function countPendingProposals(
  workspaceId: string
): Promise<number> {
  const rows = await db
    .select({ count: drizzleSql<number>`cast(count(*) as integer)` })
    .from(proposals)
    .where(
      and(
        eq(proposals.workspaceId, workspaceId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
  return rows[0]?.count ?? 0;
}

/**
 * Revise the human-readable `summary` / `reasoning` COLUMNS of a still-pending
 * proposal. No-op fields are ignored by the caller (which requires at least
 * one). Only pending proposals are touched (the WHERE guards it).
 */
export async function reviseProposal(params: {
  proposalId: string;
  summary?: string;
  reasoning?: string;
}): Promise<void> {
  const updateData: { summary?: string; reasoning?: string } = {};
  if (params.summary !== undefined) updateData.summary = params.summary;
  if (params.reasoning !== undefined) updateData.reasoning = params.reasoning;

  await db
    .update(proposals)
    .set({ ...updateData, updatedAt: new Date() })
    .where(
      and(
        eq(proposals.id, params.proposalId),
        eq(proposals.status, ProposalStatus.PENDING)
      )
    );
}
