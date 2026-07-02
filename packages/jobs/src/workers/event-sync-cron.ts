/**
 * Event Sync Cron Worker
 *
 * Thin scheduler: on a cron tick it invokes the capability-heavy event sync
 * (event entities + Stellar deadlines + Google Calendar → native Discord
 * scheduled events), which lives in @synap/api.
 *
 * This worker runs IN the backend (apps/api) process, but @synap/jobs cannot
 * statically import @synap/api (circular dep: api → jobs → database). So apps/api
 * fills the `eventSyncRunner` slot at boot via `registerEventSyncRunner()` — the
 * IoC pattern used across this package. No HTTP loopback, no shared secret.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "event-sync-cron" });

export const EVENT_SYNC_CRON_QUEUE = "event-sync-cron";

type EventSyncRunner = () => Promise<unknown>;

let eventSyncRunner: EventSyncRunner | null = null;

export function registerEventSyncRunner(fn: EventSyncRunner): void {
  eventSyncRunner = fn;
}

export async function handleEventSyncCron(_job: PgBoss.Job): Promise<void> {
  if (!eventSyncRunner) {
    logger.warn("event-sync runner not registered — skipping tick");
    return;
  }

  try {
    const result = await eventSyncRunner();
    logger.info({ result }, "event-sync run complete");
  } catch (err) {
    logger.error({ err }, "event-sync run failed");
  }
}
