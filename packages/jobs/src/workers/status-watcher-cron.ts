/**
 * STATUS WATCHER cron (status-flow plan W6) — thin scheduler: every hour it
 * runs the watcher that notices what is late, close to its date, stuck in its
 * step, or paused past its review date, and raises each ONCE per episode
 * (`runStatusWatcher`, @synap/api `services/status/watcher.ts`).
 *
 * @synap/jobs cannot import @synap/api (api → jobs), so apps/api fills the
 * runner slot at boot (`registerStatusWatcherRunner`) — the stale-proposal
 * cron's pattern. A failed tick is logged; the next tick finds the same open
 * episodes, so nothing is lost.
 */
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "status-watcher-cron" });

export const STATUS_WATCHER_QUEUE = "status-watcher";
/** Hourly, off the hold-resume minute (23) so a resumed hold is not reviewed. */
export const STATUS_WATCHER_CRON = "41 * * * *";

type StatusWatcherRunner = () => Promise<unknown>;

let statusWatcherRunner: StatusWatcherRunner | null = null;

export function registerStatusWatcherRunner(fn: StatusWatcherRunner): void {
  statusWatcherRunner = fn;
}

export async function handleStatusWatcherCron(): Promise<void> {
  if (!statusWatcherRunner) {
    logger.warn(
      "status watcher runner not registered — apps/api must call registerStatusWatcherRunner() at boot"
    );
    return;
  }
  try {
    const result = await statusWatcherRunner();
    logger.debug({ result }, "status watcher tick complete");
  } catch (err) {
    logger.error({ err }, "status watcher tick failed");
  }
}
