/**
 * Broken-Automation Cron Worker
 *
 * Thin scheduler: on a cron tick it invokes the broken-automation scan
 * (automations flipped to status='error' → an `automation.broken` notification),
 * which lives in @synap/api.
 *
 * @synap/jobs cannot statically import @synap/api (circular dep), so apps/api
 * fills the `brokenAutomationRunner` slot at boot via
 * `registerBrokenAutomationRunner()` — the same IoC pattern as stale-proposal-cron.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "broken-automation-cron" });

export const BROKEN_AUTOMATION_CRON_QUEUE = "broken-automation-cron";

type BrokenAutomationRunner = () => Promise<unknown>;

let brokenAutomationRunner: BrokenAutomationRunner | null = null;

export function registerBrokenAutomationRunner(
  fn: BrokenAutomationRunner
): void {
  brokenAutomationRunner = fn;
}

export async function handleBrokenAutomationCron(
  _job: PgBoss.Job
): Promise<void> {
  if (!brokenAutomationRunner) {
    logger.warn("broken-automation runner not registered — skipping tick");
    return;
  }

  try {
    const result = await brokenAutomationRunner();
    logger.info({ result }, "broken-automation scan complete");
  } catch (err) {
    logger.error({ err }, "broken-automation scan failed");
  }
}
