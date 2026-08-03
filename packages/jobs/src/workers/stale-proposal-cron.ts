/**
 * Stale-Proposal Cron Worker
 *
 * Thin scheduler: on a cron tick it invokes the stale-proposal scan (pending
 * proposals whose target workspace the owner can no longer reach → a
 * `governance.proposal_stale` notification), which lives in @synap/api.
 *
 * @synap/jobs cannot statically import @synap/api (circular dep: api → jobs →
 * database), so apps/api fills the `staleProposalRunner` slot at boot via
 * `registerStaleProposalRunner()` — the same IoC pattern as event-sync-cron.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "stale-proposal-cron" });

export const STALE_PROPOSAL_CRON_QUEUE = "stale-proposal-cron";

type StaleProposalRunner = () => Promise<unknown>;

let staleProposalRunner: StaleProposalRunner | null = null;

export function registerStaleProposalRunner(fn: StaleProposalRunner): void {
  staleProposalRunner = fn;
}

export async function handleStaleProposalCron(_job: PgBoss.Job): Promise<void> {
  if (!staleProposalRunner) {
    logger.warn("stale-proposal runner not registered — skipping tick");
    return;
  }

  try {
    const result = await staleProposalRunner();
    logger.info({ result }, "stale-proposal scan complete");
  } catch (err) {
    logger.error({ err }, "stale-proposal scan failed");
  }
}
