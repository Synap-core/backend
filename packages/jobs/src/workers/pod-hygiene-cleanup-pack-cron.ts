/**
 * Pod Hygiene — Cleanup Pack Worker
 *
 * Thin handler: invokes the cleanup-pack scanner, which files ONE reviewable
 * `pod_hygiene/cleanup_pack` proposal per human owner (stale work sessions,
 * long-waiting objectWork proposals, zero-entity non-core kinds, never-run
 * automations). It never applies anything — approval does, through the
 * existing doors.
 *
 * The scanner lives in @synap/api (`fileCleanupPacks`) because the session KIND
 * and the proposal CLASS are api-owned rules. @synap/jobs cannot statically
 * import @synap/api (circular dep), so apps/api fills the slot at boot via
 * `registerCleanupPackRunner()` — the same IoC pattern as stale-proposal-cron.
 *
 * Queue: pod-hygiene.cleanup-pack (worked — a manual `boss.send` runs it)
 * Cron:  NOT SCHEDULED. Add `scheduleSafe(…, POD_HYGIENE_CLEANUP_PACK_CRON)` to
 *        cron.ts only once relay renders a pack's items with a per-item
 *        "Leave out" (`proposals.rejectItem`); until then one Approve applies
 *        every item unseen. Pinned by
 *        `__tripwires__/cleanup-pack-cron-unscheduled.tripwire.test.ts`.
 */

import type PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "pod-hygiene-cleanup-pack-cron" });

export const POD_HYGIENE_CLEANUP_PACK_QUEUE = "pod-hygiene.cleanup-pack";

export const POD_HYGIENE_CLEANUP_PACK_CRON = "20 4 * * *";

type CleanupPackRunner = () => Promise<unknown>;

let cleanupPackRunner: CleanupPackRunner | null = null;

export function registerCleanupPackRunner(fn: CleanupPackRunner): void {
  cleanupPackRunner = fn;
}

export async function handleCleanupPackCron(_job?: PgBoss.Job): Promise<void> {
  if (!cleanupPackRunner) {
    logger.warn("cleanup-pack runner not registered — skipping tick");
    return;
  }

  try {
    const result = await cleanupPackRunner();
    logger.info({ result }, "cleanup-pack scan complete");
  } catch (err) {
    logger.error({ err }, "cleanup-pack scan failed");
  }
}
