/**
 * Governance TIGHTEN scan — the cron half of the calibration loop's
 * "the humans keep saying no" lane.
 *
 * The recommender itself (`recommendTightenForAllAgents`,
 * `packages/api/src/services/proposals/recommend-tighten.ts`) was reachable
 * ONLY through a pod-admin-invoked verb, so on a pod nobody invoked it on, a
 * motif the humans reject 20 times in a row was never pinned back to review.
 * Its twin, the WIDEN scanner (`governance-lane-scanner.ts`), has run daily
 * since the queue fix. This file gives tighten the same wiring: a queue in
 * `ALL_QUEUES`, a worker, a daily schedule offset from its siblings.
 *
 * @synap/jobs cannot import @synap/api (circular dep), so apps/api fills the
 * slot at boot with `registerTightenRecommender` — the same IoC inversion as
 * `stale-proposal-cron.ts` / `session-close.ts`.
 *
 * NEVER SILENT, in both directions:
 *   - an UNREGISTERED slot THROWS (the job fails and pg-boss records it). A
 *     tick that logs "skipping" every night is the severance-that-reports-
 *     success this repo has shipped before (`governance.lane-scan`).
 *   - per-agent failures are caught INSIDE the recommender (one agent never
 *     aborts the batch) and COUNTED into `agentsFailed`; a non-zero count is
 *     logged at error level here. A thrown scan propagates.
 *
 * Dedupe is the recommender's own `hasPendingFinding` — one open finding per
 * (agent, motif), so a daily tick never re-files a finding a human has not
 * decided yet.
 *
 * Queue: governance.tighten-scan
 * Cron:  daily 35 3 * * * (after the widen lane scan at 3:30)
 */

import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "governance-tighten-cron" });

export const GOVERNANCE_TIGHTEN_SCAN_QUEUE = "governance.tighten-scan";

/** Daily 03:35 UTC — five minutes after the widen lane scan. */
export const GOVERNANCE_TIGHTEN_SCAN_CRON = "35 3 * * *";

/** Structurally mirrors api's `recommendTightenForAllAgents` result. */
export interface TightenScanResult {
  proposalsFiled: number;
  proposalIds: string[];
  agentsFailed: number;
}

export type TightenRecommender = () => Promise<TightenScanResult>;

let tightenRecommender: TightenRecommender | null = null;

export function registerTightenRecommender(fn: TightenRecommender): void {
  tightenRecommender = fn;
}

export async function handleGovernanceTightenScan(): Promise<TightenScanResult> {
  if (!tightenRecommender) {
    throw new Error(
      "Tighten recommender not registered — apps/api must call registerTightenRecommender() at boot"
    );
  }
  const result = await tightenRecommender();
  if (result.agentsFailed > 0) {
    logger.error(
      result,
      "governance.tighten-scan: one or more agents failed to scan (see recommend-tighten errors)"
    );
  } else {
    logger.info(result, "governance.tighten-scan: complete");
  }
  return result;
}
