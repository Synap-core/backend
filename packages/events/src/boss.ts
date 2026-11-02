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

// Use globalThis to share the singleton across pnpm module instances.
// pnpm can create multiple copies of @synap/events when packages resolve
// peer dependencies differently, giving each copy its own module-level
// _boss variable. Storing on globalThis ensures all copies share one instance.
const GLOBAL_KEY = "__synap_pg_boss__";

function getGlobal(): PgBoss | null {
  return (
    ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as PgBoss | null) ??
    null
  );
}

function setGlobal(boss: PgBoss | null): void {
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = boss;
}

// pg-boss's OWN pool (a `pg.Pool`, separate from the Drizzle pool in
// @synap/database client-pg.ts). Unset, pg-pool caps it at 10; it is named
// here so the pod's Postgres connection budget (client-pg.ts) can count it,
// and so the update canary can run with a smaller one (docker-compose.yml).
const DEFAULT_PGBOSS_POOL_SIZE = 10;

export function pgBossPoolSize(raw = process.env.PGBOSS_POOL_SIZE): number {
  const n = parseInt(raw || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PGBOSS_POOL_SIZE;
}

function createBoss(): PgBoss {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for pg-boss");
  }

  return new PgBoss({
    connectionString,
    // pg-boss 10 hands its config to `new pg.Pool(config)` (src/db.js).
    max: pgBossPoolSize(),
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
  let boss = getGlobal();
  if (!boss) {
    boss = createBoss();
    setGlobal(boss);
  }
  return boss;
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
  const boss = getGlobal();
  if (boss) {
    await boss.stop({ graceful: true, timeout: 10_000 });
    logger.info("pg-boss stopped");
    setGlobal(null);
  }
}

// Default export for convenience
export const boss = getBoss();
