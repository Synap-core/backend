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
import type { ProposalRevision } from "@synap/database";

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
 * Revise the human-readable `summary` / `reasoning` of a still-pending
 * proposal. These are NOT columns on `proposals` — they live inside the
 * `data` JSONB payload (read back via `request.summary` / `request.reasoning`
 * in `buildProposalReviewModel`) — so the update merges into `data` rather
 * than setting phantom columns. No-op fields are ignored by the caller
 * (which requires at least one). Only pending proposals are touched (the
 * WHERE guards it).
 */
export async function reviseProposal(params: {
  proposalId: string;
  summary?: string;
  reasoning?: string;
  /** The actor filing the revision — recorded as `by` on the history entry. */
  actorId?: string | null;
}): Promise<void> {
  const patch: { summary?: string; reasoning?: string } = {};
  if (params.summary !== undefined) patch.summary = params.summary;
  if (params.reasoning !== undefined) patch.reasoning = params.reasoning;

  // Read-then-write in one transaction so the before/after snapshot is captured
  // atomically against a concurrent revision. Load the current data payload to
  // record the prior values of only the fields this patch changes (D3b — the
  // "human corrected the AI" quality signal the analyzer loop feeds on).
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ data: proposals.data })
      .from(proposals)
      .where(
        and(
          eq(proposals.id, params.proposalId),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      )
      .limit(1)
      .for("update");
    // No pending row → nothing to revise (the UPDATE below is also a no-op).
    if (!existing) return;

    const prior = (existing.data ?? {}) as Record<string, unknown>;
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      before[key] = prior[key];
    }
    const revision: ProposalRevision = {
      at: new Date().toISOString(),
      by: params.actorId ?? null,
      before,
      patch,
    };

    // postgres.js 3.4.8 sql.json() is broken on the pod image — always
    // JSON.stringify + ::jsonb. In Drizzle .set() use drizzleSql, not raw sql.
    await tx
      .update(proposals)
      .set({
        data: drizzleSql`COALESCE(${proposals.data}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
        revisionHistory: drizzleSql`COALESCE(${proposals.revisionHistory}, '[]'::jsonb) || ${JSON.stringify([revision])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(proposals.id, params.proposalId),
          eq(proposals.status, ProposalStatus.PENDING)
        )
      );
  });
}
