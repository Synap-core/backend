/**
 * Frame read log retention: keep FRAME_READ_LOG_RETENTION_DAYS (30) of
 * `frame_read_log`.
 *
 * The log is one row per read a framed surface asked the frame read door for
 * (migration 0456). The inspect door (`surfaces.inspect`) reads at most the
 * last 30 days of it, so older rows answer nothing it asks: the daily cron
 * deletes them (`deleteExpiredFrameReads`), through the `(at)` index
 * (migration 0458), and counts them in the database: the deleted ids never
 * travel back.
 */

import {
  db,
  drizzleSql,
  frameReadLog,
  FRAME_READ_LOG_RETENTION_DAYS,
} from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "frame-read-log-retention" });

export const FRAME_READ_LOG_RETENTION_QUEUE = "frame-read-log-retention";
/** Daily at 2:35 AM UTC, beside the other cleanups. */
export const FRAME_READ_LOG_RETENTION_CRON = "35 2 * * *";

type DeleteDb = Pick<typeof db, "execute">;

/** postgres-js answers an array-like RowList; PGlite and node-postgres `{ rows }`. */
function firstRow<T>(result: unknown): T | undefined {
  if (Array.isArray(result)) return result[0] as T | undefined;
  return (result as { rows?: T[] } | null)?.rows?.[0];
}

/** Delete log rows older than `days` (default 30). Returns how many went. */
export async function deleteExpiredFrameReads(
  executor: DeleteDb,
  days: number = FRAME_READ_LOG_RETENTION_DAYS,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const result = await executor.execute(drizzleSql`
    WITH gone AS (
      DELETE FROM ${frameReadLog}
      WHERE ${frameReadLog.at} < ${cutoff.toISOString()}
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM gone
  `);
  return Number(firstRow<{ n: number }>(result)?.n ?? 0);
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
