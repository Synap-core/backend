/**
 * pg-boss Client
 *
 * Postgres-native job queue that replaces Inngest.
 * Uses the same DATABASE_URL as the rest of the app.
 * All tables are created in the "pgboss" schema automatically.
 */

import PgBoss from "pg-boss";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "pg-boss" });

let _boss: PgBoss | null = null;

function createBoss(): PgBoss {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for pg-boss");
  }

  return new PgBoss({
    connectionString,
    schema: "pgboss",
    // Monitoring interval for job polling (2 seconds for responsiveness)
    monitorStateIntervalSeconds: 30,
    // Archive completed jobs after 7 days
    archiveCompletedAfterSeconds: 7 * 24 * 60 * 60,
    // Delete archived jobs after 30 days
    deleteAfterSeconds: 30 * 24 * 60 * 60,
    // Retry failed jobs up to 3 times
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
  });
}

/**
 * Get the pg-boss singleton instance.
 * Creates if not yet initialized but does NOT start it.
 */
export function getBoss(): PgBoss {
  if (!_boss) {
    _boss = createBoss();
  }
  return _boss;
}

/**
 * Start the pg-boss worker. Must be called once on server startup.
 */
export async function startBoss(): Promise<void> {
  const boss = getBoss();
  await boss.start();
  logger.info("pg-boss started");
}

/**
 * Stop the pg-boss worker gracefully. Call on server shutdown.
 */
export async function stopBoss(): Promise<void> {
  if (_boss) {
    await _boss.stop({ graceful: true, timeout: 10_000 });
    logger.info("pg-boss stopped");
    _boss = null;
  }
}
