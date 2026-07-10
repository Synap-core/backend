/**
 * Cal.com Backfill Cron Worker
 *
 * Thin scheduler: on a cron tick it invokes the capability-heavy Cal.com backfill
 * (cal_list_bookings → map → capture/graph), which lives in @synap/api. Safety net
 * for the inbound webhook — catches bookings missed during pod downtime.
 *
 * Runs IN the backend (apps/api) process, but @synap/jobs cannot statically import
 * @synap/api (circular dep). So apps/api fills the `calBackfillRunner` slot at boot
 * via `registerCalBackfillRunner()` — the same IoC pattern as mail-feed / event-sync.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cal-backfill-cron" });

export const CAL_BACKFILL_CRON_QUEUE = "cal-backfill-cron";

type CalBackfillRunner = () => Promise<unknown>;

let calBackfillRunner: CalBackfillRunner | null = null;

export function registerCalBackfillRunner(fn: CalBackfillRunner): void {
  calBackfillRunner = fn;
}

export async function handleCalBackfillCron(_job: PgBoss.Job): Promise<void> {
  if (!calBackfillRunner) {
    logger.warn("cal-backfill runner not registered — skipping tick");
    return;
  }

  try {
    const result = await calBackfillRunner();
    logger.info({ result }, "cal-backfill run complete");
  } catch (err) {
    logger.error({ err }, "cal-backfill run failed");
  }
}
