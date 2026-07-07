/**
 * Event End Cron Worker
 *
 * Thin scheduler: on a cron tick it invokes the api-side "event end" runner,
 * which finds `event` entities whose `endDate` has just crossed `now` and, for
 * each event that still has an ACTIVE focus session bound to it (event mode),
 * flips that session's stage to `post` — which emits `focus_session.stage_changed`
 * and (via the session-recap reactor) enqueues the recap.
 *
 * This worker runs IN the backend (apps/api) process, but @synap/jobs cannot
 * statically import @synap/api (circular dep: api → jobs → database). So apps/api
 * fills the `eventEndRunner` slot at boot via `registerEventEndRunner()` — the
 * SAME IoC pattern as `event-sync-cron`. No HTTP loopback, no shared secret.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "event-end-cron" });

export const EVENT_END_CRON_QUEUE = "event-end-cron";

type EventEndRunner = () => Promise<unknown>;

let eventEndRunner: EventEndRunner | null = null;

export function registerEventEndRunner(fn: EventEndRunner): void {
  eventEndRunner = fn;
}

export async function handleEventEndCron(_job: PgBoss.Job): Promise<void> {
  if (!eventEndRunner) {
    logger.warn("event-end runner not registered — skipping tick");
    return;
  }

  try {
    const result = await eventEndRunner();
    logger.info({ result }, "event-end run complete");
  } catch (err) {
    logger.error({ err }, "event-end run failed");
  }
}
