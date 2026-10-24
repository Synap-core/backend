/**
 * Proposal Approve Worker (a LARGE approval, applied in the background)
 *
 * The approve door runs every gate in the request, records a
 * `proposal_apply_runs` row and sends its id here. The handler applies the
 * proposal through the same approval door and writes progress to that row
 * (`services/proposals/approval-runs.ts` in @synap/api).
 *
 * Inversion of Control, like `import-corpus-worker.ts`: jobs must not import
 * @synap/api, so this module owns the QUEUE and a handler SLOT that the api
 * layer fills at boot (apps/api/src/index.ts).
 *
 * Queue policy: `retryLimit: 0` and a 4-hour expiry (`LONG_WALK_QUEUES` in
 * ./index.ts). A redelivery while the first delivery still runs would apply
 * the graph twice at once; a worker that dies leaves its run `running`, and
 * readers report it `stalled` once its heartbeat stops, with resume offered.
 *
 * Queue: "proposal-approve"
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "proposal-approve-worker" });

export const PROPOSAL_APPROVE_QUEUE = "proposal-approve";

/**
 * Longest a delivery may run before pg-boss expires it: 4 hours. A 4,222-op
 * import took ~15 min at ~5 ops/s; this leaves room for ~70k operations.
 * pg-boss 10 caps expiry below 24 h.
 */
export const PROPOSAL_APPROVE_EXPIRE_SECONDS = 4 * 60 * 60;

export interface ProposalApprovePayload {
  /** The `proposal_apply_runs` row this delivery applies. */
  runId: string;
}

export interface ProposalApproveOutcome {
  status: "succeeded" | "failed" | "skipped";
}

type Handler = (p: ProposalApprovePayload) => Promise<ProposalApproveOutcome>;

let handler: Handler | null = null;

export function registerProposalApproveHandler(fn: Handler): void {
  handler = fn;
}

export async function handleProposalApprove(
  job: PgBoss.Job<ProposalApprovePayload>
): Promise<ProposalApproveOutcome> {
  if (!handler) {
    throw new Error("proposal-approve handler not registered");
  }
  const startedAt = Date.now();
  const outcome = await handler(job.data);
  logger.info(
    {
      runId: job.data.runId,
      status: outcome.status,
      durationMs: Date.now() - startedAt,
    },
    "Background approval finished"
  );
  return outcome;
}
