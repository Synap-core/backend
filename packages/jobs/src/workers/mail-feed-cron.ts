/**
 * Mail Feed Cron Worker
 *
 * Thin scheduler: on a cron tick it invokes the capability-heavy mail feed
 * (gmail_search + IS triage + posting into the Discord-bound Synap channel),
 * which lives in @synap/api.
 *
 * This worker runs IN the backend (apps/api) process, but @synap/jobs cannot
 * statically import @synap/api (circular dep: api → jobs → database). So apps/api
 * fills the `mailFeedRunner` slot at boot via `registerMailFeedRunner()` — the
 * IoC pattern used across this package. No HTTP loopback, no shared secret.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "mail-feed-cron" });

export const MAIL_FEED_CRON_QUEUE = "mail-feed-cron";

type MailFeedRunner = () => Promise<unknown>;

let mailFeedRunner: MailFeedRunner | null = null;

export function registerMailFeedRunner(fn: MailFeedRunner): void {
  mailFeedRunner = fn;
}

export async function handleMailFeedCron(_job: PgBoss.Job): Promise<void> {
  if (!mailFeedRunner) {
    logger.warn("mail-feed runner not registered — skipping tick");
    return;
  }

  try {
    const result = await mailFeedRunner();
    logger.info({ result }, "mail-feed run complete");
  } catch (err) {
    logger.error({ err }, "mail-feed run failed");
  }
}
