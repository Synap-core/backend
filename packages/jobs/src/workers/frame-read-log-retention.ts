/**
 * Frame read log retention (Surfaces P7) — keep FRAME_READ_LOG_RETENTION_DAYS
 * (30) of `frame_read_log`.
 *
 * The log is one row per read a framed surface asked the frame read door for
 * (migration 0456). The inspect door (`surfaces.inspect`) reads at most the
 * last 30 days of it, so older rows answer nothing it asks: the daily cron
 * deletes them (`deleteExpiredFrameReads`).
 */

import {
  db,
  frameReadLog,
  FRAME_READ_LOG_RETENTION_DAYS,
  lt,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "frame-read-log-retention" });

export const FRAME_READ_LOG_RETENTION_QUEUE = "frame-read-log-retention";
/** Daily at 2:35 AM UTC, beside the other cleanups. */
export const FRAME_READ_LOG_RETENTION_CRON = "35 2 * * *";

type DeleteDb = Pick<typeof db, "delete">;

/** Delete log rows older than `days` (default 30). Returns how many went. */
export async function deleteExpiredFrameReads(
  executor: DeleteDb,
  days: number = FRAME_READ_LOG_RETENTION_DAYS,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const gone = await executor
    .delete(frameReadLog)
    .where(lt(frameReadLog.at, cutoff))
    .returning({ id: frameReadLog.id });
  return gone.length;
}

export async function handleFrameReadLogRetention(
  now: Date = new Date()
): Promise<number> {
  try {
    const deleted = await deleteExpiredFrameReads(
      db,
      FRAME_READ_LOG_RETENTION_DAYS,
      now
    );
    if (deleted > 0) {
      logger.info({ deleted }, "Expired frame read log rows deleted");
    }
    return deleted;
  } catch (error) {
    logger.error({ error }, "Frame read log retention failed");
    throw error;
  }
}
