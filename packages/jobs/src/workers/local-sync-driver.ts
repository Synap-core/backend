/**
 * Local Sync Driver
 *
 * pg-boss-independent sync loop used when LOCAL_MODE=true (embedded Electron pod).
 * pg-boss requires a full Postgres schema; PGlite (Phase 9) has pg-boss running,
 * but before pg-boss is confirmed working on PGlite we guard with this driver so
 * the local pod can still replicate without depending on the job queue.
 *
 * When localMode=true this driver is started in apps/api/src/index.ts INSTEAD of
 * (or alongside) the pg-boss cron registrations. When no remote peer is configured
 * the tick functions are silent no-ops.
 *
 * Intervals:
 *   push / pull          60 s   (matches the pg-boss cron "* * * * *")
 *   supplementary push  300 s   (matches every-5-min cron)
 *   file push           600 s   (matches every-10-min cron)
 */

import { createLogger } from "@synap-core/core";
import { handleSyncPush } from "./sync-push.js";
import { handleSyncPull } from "./sync-pull.js";
import { handleSyncPushSupplementary } from "./sync-push-supplementary.js";

const logger = createLogger({ module: "local-sync-driver" });

/** Interval handles so we can stop the driver cleanly. */
const handles: ReturnType<typeof setInterval>[] = [];

/** Whether the driver is currently running. */
let running = false;

/**
 * Wrap a sync worker function for safe recurring execution.
 * Each tick is independent — an error in one tick never stops the next.
 */
function safeTick(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err) => {
      logger.error(
        { err, worker: name },
        "Local sync tick failed — will retry next interval"
      );
    });
  };
}

/**
 * Start the local sync driver.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export function startLocalSyncDriver(): void {
  if (process.env.LOCAL_MODE !== "true") {
    logger.error(
      "startLocalSyncDriver() called but LOCAL_MODE is not enabled — refusing to start"
    );
    return;
  }

  if (running) {
    logger.warn("Local sync driver already running — ignoring duplicate start");
    return;
  }
  running = true;

  // Push/pull: every 60 s
  handles.push(setInterval(safeTick("sync-push", handleSyncPush), 60_000));
  handles.push(setInterval(safeTick("sync-pull", handleSyncPull), 60_000));

  // Supplementary push: every 5 min
  handles.push(
    setInterval(
      safeTick("sync-push-supplementary", handleSyncPushSupplementary),
      300_000
    )
  );

  // File sync worker is imported lazily to avoid pulling in heavy deps at startup
  handles.push(
    setInterval(
      safeTick("sync-push-files", async () => {
        const { handleSyncPushFiles } = await import("./sync-push-files.js");
        await handleSyncPushFiles();
      }),
      600_000
    )
  );

  logger.info(
    {
      pushIntervalMs: 60_000,
      pullIntervalMs: 60_000,
      supplementaryIntervalMs: 300_000,
      filesIntervalMs: 600_000,
    },
    "Local sync driver started"
  );
}

/**
 * Stop the local sync driver and clear all intervals.
 * Called during graceful shutdown.
 */
export function stopLocalSyncDriver(): void {
  if (!running) return;
  for (const handle of handles) {
    clearInterval(handle);
  }
  handles.length = 0;
  running = false;
  logger.info("Local sync driver stopped");
}
