/**
 * API usage retention (0364) — keep 30 days of `api_usage_buckets`.
 *
 * The table is request telemetry (calls per key / client / conversation per
 * 5 minutes), not governance lineage: older buckets answer nothing the 30-day
 * read door asks, so the daily cron deletes them (`deleteExpiredApiUsage`).
 */

import { db, deleteExpiredApiUsage } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "api-usage-retention" });

export const API_USAGE_RETENTION_QUEUE = "api-usage-retention";
/** Daily at 2:25 AM UTC, beside the other cleanups. */
export const API_USAGE_RETENTION_CRON = "25 2 * * *";

export async function handleApiUsageRetention(): Promise<number> {
  try {
    const deleted = await deleteExpiredApiUsage(db);
    if (deleted > 0) {
      logger.info({ deleted }, "Expired API usage buckets deleted");
    }
    return deleted;
  } catch (error) {
    logger.error({ error }, "API usage retention failed");
    throw error;
  }
}
