/**
 * The hourly STATUS WATCHER tick. The watcher lives in @synap/api, which
 * depends on @synap/jobs, so apps/api fills this runner slot at boot.
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
