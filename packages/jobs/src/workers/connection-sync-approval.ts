/**
 * Connection Sync Approval Worker
 *
 * On-demand queue. Enqueued by the `connection-sync-approval` reactor in
 * @synap/events for every `proposal.approved` emit (and by the approval path for
 * a pod-wide one). Loads the proposal and, when it is a connection's
 * `import.graph` with "keep syncing" on and the approver owns the connection,
 * mints the connection's `auto` governance rule through the one helper
 * (`applyConnectionSyncApprovalForProposal`, @synap/database).
 *
 * Failures THROW so pg-boss retries — a rule that silently failed to mint would
 * leave every later sync proposing with nothing saying why.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";
import { applyConnectionSyncApprovalForProposal } from "@synap/database";

const logger = createLogger({ module: "connection-sync-approval" });

export const CONNECTION_SYNC_APPROVAL_QUEUE = "connection-sync-approval";

export interface ConnectionSyncApprovalJob {
  proposalId: string;
  userId: string;
}

export async function handleConnectionSyncApproval(
  job: PgBoss.Job<Partial<ConnectionSyncApprovalJob> | null>
): Promise<void> {
  const { proposalId, userId } = job.data ?? {};
  if (!proposalId || !userId) {
    logger.warn(
      { data: job.data },
      "connection-sync-approval job missing proposalId/userId"
    );
    return;
  }

  const outcome = await applyConnectionSyncApprovalForProposal({
    proposalId,
    userId,
  });

  if (outcome.applied) {
    logger.info(
      { proposalId, ruleId: outcome.ruleId, created: outcome.created },
      "connection sync approval: auto rule ensured"
    );
    return;
  }
  // Ordinary approvals land here by the thousand — only the connection-sync
  // skips are worth a line.
  if (
    outcome.skipped !== "not-import-graph" &&
    outcome.skipped !== "not-connection-sync"
  ) {
    logger.warn(
      { proposalId, skipped: outcome.skipped },
      "connection sync approval: no auto rule minted"
    );
  }
}
