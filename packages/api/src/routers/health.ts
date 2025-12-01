/**
 * Health Check Router
 * 
 * Provides monitoring endpoints for system health and readiness
 */

import { router, publicProcedure } from '../trpc.js';
import { db, sql } from '@synap/database';
import { createLogger } from '@synap/core';

const healthLogger = createLogger({ module: 'health-router' });

export const healthRouter = router({
  /**
   * Liveness probe - basic "is the service running" check
   * Should always return quickly, used by orchestrators
   */
  alive: publicProcedure.query(() => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }),

  /**
   * Readiness probe - is the service ready to handle traffic
   * Checks all critical dependencies
   */
  ready: publicProcedure.query(async () => {
    const checks = await Promise.allSettled([
      checkDatabase(),
      checkInngest(),
    ]);

    const databaseOk = checks[0].status === 'fulfilled';
    const inngestOk = checks[1].status === 'fulfilled';

    const allReady = databaseOk && inngestOk;

    return {
      status: allReady ? 'ready' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        database: databaseOk ? 'healthy' : 'unhealthy',
        inngest: inngestOk ? 'healthy' : 'unhealthy',
      },
      details: {
        database: databaseOk ? undefined : (checks[0] as PromiseRejectedResult).reason?.message,
        inngest: inngestOk ? undefined : (checks[1] as PromiseRejectedResult).reason?.message,
      },
    };
  }),

  /**
   * Migration status - shows applied database migrations
   */
  migrations: publicProcedure.query(async () => {
    try {
      const result = await db.execute(sql`
        SELECT version, applied_at, description
        FROM schema_migrations
        ORDER BY applied_at DESC
        LIMIT 20
      `);

      return {
        total: result.rows.length,
        migrations: result.rows.map((row: any) => ({
          version: row.version,
          appliedAt: row.applied_at,
          description: row.description,
        })),
      };
    } catch (error) {
      healthLogger.error({ err: error }, 'Failed to fetch migration status');
      throw new Error('Migration table not accessible');
    }
  }),

  /**
   * System metrics - basic operational metrics
   */
  metrics: publicProcedure.query(async () => {
    const [eventCount, entityCount] = await Promise.allSettled([
      db.execute(sql`SELECT COUNT(*) as count FROM events_timescale WHERE timestamp > NOW() - INTERVAL '24 hours'`),
      db.execute(sql`SELECT COUNT(*) as count FROM entities`),
    ]);

    return {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      events24h: eventCount.status === 'fulfilled' ? Number(eventCount.value.rows[0]?.count) : null,
      totalEntities: entityCount.status === 'fulfilled' ? Number(entityCount.value.rows[0]?.count) : null,
    };
  }),
});

/**
 * Check database connectivity
 */
async function checkDatabase(): Promise<void> {
  const result = await db.execute(sql`SELECT 1 as healthy`);
  if (!result.rows[0]?.healthy) {
    throw new Error('Database ping failed');
  }
}

/**
 * Check Inngest connectivity
 */
async function checkInngest(): Promise<void> {
  // Simple check - if we can import inngest, it's configured
  // For deeper checks, you could ping the Inngest dev server
  try {
    const { inngest } = await import('../utils/inngest-client.js');
    if (!inngest) {
      throw new Error('Inngest client not initialized');
    }
  } catch (error) {
    throw new Error(`Inngest check failed: ${error}`);
  }
}
