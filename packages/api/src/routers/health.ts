/**
 * Health Check Router
 *
 * Provides monitoring endpoints for system health and readiness
 */

import { router, publicProcedure } from "../trpc.js";
import { sql } from "@synap/database";

export const healthRouter = router({
  /**
   * Liveness probe - basic "is the service running" check
   * Should always return quickly, used by orchestrators
   */
  alive: publicProcedure.query(() => {
    return { status: "ok", timestamp: new Date().toISOString() };
  }),

  /**
   * Readiness probe - is the service ready to handle traffic
   * Checks all critical dependencies
   */
  ready: publicProcedure.query(async () => {
    const checks = await Promise.allSettled([checkDatabase(), checkJobQueue()]);

    const databaseOk = checks[0].status === "fulfilled";
    const jobQueueOk = checks[1].status === "fulfilled";

    const allReady = databaseOk && jobQueueOk;

    return {
      status: allReady ? "ready" : "degraded",
      timestamp: new Date().toISOString(),
      checks: {
        database: databaseOk ? "healthy" : "unhealthy",
        jobQueue: jobQueueOk ? "healthy" : "unhealthy",
      },
      details: {
        database: databaseOk
          ? undefined
          : (checks[0] as PromiseRejectedResult).reason?.message,
        jobQueue: jobQueueOk
          ? undefined
          : (checks[1] as PromiseRejectedResult).reason?.message,
      },
    };
  }),

  /**
   * Migration status - shows applied database migrations
   */
  migrations: publicProcedure.query(async () => {
    try {
      const rows = await sql`
        SELECT id, hash, created_at
        FROM drizzle.__drizzle_migrations
        ORDER BY created_at DESC
        LIMIT 20
      `;
      return {
        total: rows.length,
        migrations: rows.map((r: Record<string, unknown>) => ({
          id: r.id,
          hash: r.hash,
          appliedAt: r.created_at,
        })),
      };
    } catch {
      // Table may not exist if using a different migration runner
      return {
        total: 0,
        migrations: [],
        note: "Could not query drizzle migration table",
      };
    }
  }),

  /**
   * System metrics - basic operational metrics
   */
  metrics: publicProcedure.query(async () => {
    const [eventCount, entityCount] = await Promise.allSettled([
      sql`SELECT COUNT(*) as count FROM events WHERE timestamp > NOW() - INTERVAL '24 hours'`,
      sql`SELECT COUNT(*) as count FROM entities`,
    ]);

    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      events24h:
        eventCount.status === "fulfilled" && eventCount.value?.[0]?.count
          ? Number(eventCount.value[0].count)
          : 0,
      totalEntities:
        entityCount.status === "fulfilled" && entityCount.value?.[0]?.count
          ? Number(entityCount.value[0].count)
          : 0,
    };
  }),
});

/**
 * Check database connectivity
 */
async function checkDatabase(): Promise<void> {
  // Import sql (postgres.js) for raw SQL query
  const { sql } = await import("@synap/database");
  const result = await sql`SELECT 1 as healthy`;
  if (!result[0]?.healthy) {
    throw new Error("Database ping failed");
  }
}

/**
 * Check job queue (pg-boss) connectivity
 */
async function checkJobQueue(): Promise<void> {
  try {
    const { getBoss } = await import("@synap/jobs");
    const boss = getBoss();
    if (!boss) {
      throw new Error("pg-boss not initialized");
    }
  } catch (error) {
    throw new Error(`Job queue check failed: ${error}`);
  }
}
