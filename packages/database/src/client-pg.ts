/**
 * Database Client - Pure PostgreSQL with postgres.js
 *
 * Simple, single-driver approach for pod-per-user architecture.
 * Works everywhere: local development, cloud VMs, traditional hosting.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  createLogger,
  ValidationError,
  InternalServerError,
} from "@synap-core/core";
import * as schema from "./schema/index.js";
import { dbPoolSize } from "./pool-size.js";

const logger = createLogger({ module: "database" });

// Use DATABASE_URL from environment with correct fallback password
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:synap_dev_password@localhost:5432/synap";

// Connection pool size: the cap of THIS process's postgres.js/Drizzle pool.
//
// Default raised from 10 → 50 for launch: 10 starved the API under load (it
// serves every tRPC/HTTP request beside ~40 pg-boss workers). But every
// process that imports this module gets its own pool with this cap, and they
// all share ONE Postgres. On a pod (deploy/docker-compose.yml) the consumers:
//
//   backend          DB_POOL_SIZE (20 on a pod) + 1 dedicated LISTEN connection
//                    + pg-boss's own pool, PGBOSS_POOL_SIZE (10, events/boss.ts)
//   backend-worker   WORKER_DB_POOL_SIZE (20) + 1 + WORKER_PGBOSS_POOL_SIZE (10),
//                    only when SYNAP_SPLIT_WORKERS=1 (the job workers in their
//                    own process, plan P6)
//   backend-canary   CANARY_DB_POOL_SIZE (10) + 1 + CANARY_PGBOSS_POOL_SIZE (5),
//                    only while `synap update` validates an image
//   realtime         REALTIME_DB_POOL_SIZE (10): socket auth, room grants,
//                    Yjs document load/save
//   backend-migrate  5 (one-shot, sequential scripts)
//   kratos, kratos-migrate   max_conns=10 each in their DSN (unset, Ory
//                    takes 2 x CPUs)
//   postgres-backup, admin psql   a handful
//
// Postgres `max_connections` is POSTGRES_MAX_CONNECTIONS (200). Before
// 2026-11-02 the canary, realtime and backend-migrate each took this default
// of 50 and the caps summed past Postgres' default 100: Kratos lost at login
// (`FATAL: sorry, too many clients already`). Every pod service connects as
// the superuser `synap`, so the superuser-reserved slots are no headroom.
// The compose file sets every cap explicitly, so this default does not reach a
// pod. Raise a cap there and you raise POSTGRES_MAX_CONNECTIONS with it, or
// deploy/__tests__/pg-connection-budget.test.sh goes red.
const DB_POOL_SIZE = dbPoolSize();

// Idle connection timeout (seconds).
//
// Default raised from 20 → 120 to avoid reconnect cold-starts after typical
// agent think-time pauses. Set DB_IDLE_TIMEOUT to override.
const DB_IDLE_TIMEOUT_RAW = parseInt(process.env.DB_IDLE_TIMEOUT || "120", 10);
const DB_IDLE_TIMEOUT = Number.isFinite(DB_IDLE_TIMEOUT_RAW)
  ? DB_IDLE_TIMEOUT_RAW
  : 120;

logger.info({
  poolSize: DB_POOL_SIZE,
  url: DATABASE_URL.replace(/:[^:@]+@/, ":***@"), // Hide password in logs
  msg: "PostgreSQL connection pool initialized (postgres.js + Drizzle)",
});

// PostgreSQL connection configuration
const connectionConfig = {
  max: DB_POOL_SIZE, // Connection pool size (env DB_POOL_SIZE, default 50)
  idle_timeout: DB_IDLE_TIMEOUT, // Close idle connections after N seconds (env DB_IDLE_TIMEOUT, default 120)
  connect_timeout: 10, // Fail fast if DB unreachable
  onnotice: () => {}, // Suppress NOTICE messages
  debug: process.env.DB_DEBUG === "true", // Enable query logging if needed
};

/**
 * PostgreSQL connection pool (postgres.js)
 *
 * Use this for raw SQL queries:
 * ```typescript
 * const result = await sql`SELECT * FROM users WHERE id = ${userId}`;
 * ```
 */
export const sql = postgres(DATABASE_URL, connectionConfig);

/**
 * Drizzle ORM instance (type-safe query builder)
 *
 * Use this for type-safe queries:
 * ```typescript
 * const users = await db.select().from(usersTable).where(eq(usersTable.id, userId));
 * ```
 */
export const db = drizzle(sql, { schema });

/**
 * Get database instance (for compatibility with existing code)
 * @returns Drizzle database instance
 */
export async function getDb() {
  return db;
}

/**
 * Set current user for Row-Level Security (RLS)
 *
 * @param userId - User ID to set as current user
 */
export async function setCurrentUser(userId: string): Promise<void> {
  if (!userId || typeof userId !== "string") {
    throw new ValidationError("Invalid userId: must be a non-empty string", {
      userId,
    });
  }

  try {
    await sql`SELECT set_current_user(${userId}::text)`;
    logger.debug({ userId }, "RLS current user set");
  } catch (error) {
    logger.error({ err: error, userId }, "Failed to set RLS current user");
    throw new InternalServerError(
      `Failed to set current user: ${error instanceof Error ? error.message : "Unknown error"}`,
      {
        userId,
        originalError: error instanceof Error ? error.message : String(error),
      }
    );
  }
}

/**
 * Clear current user for Row-Level Security (RLS)
 */
export async function clearCurrentUser(): Promise<void> {
  try {
    await sql`RESET app.current_user_id`;
    logger.debug("RLS current user cleared");
  } catch (error) {
    logger.error({ err: error }, "Failed to clear RLS current user");
    throw new InternalServerError(
      `Failed to clear current user: ${error instanceof Error ? error.message : "Unknown error"}`,
      { originalError: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Close database connections gracefully
 * Call this during application shutdown
 */
export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
  logger.info("Database connections closed");
}

// Handle process termination
process.on("SIGTERM", closeDatabase);
process.on("SIGINT", closeDatabase);
