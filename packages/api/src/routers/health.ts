/**
 * Health Check Router
 *
 * Provides monitoring endpoints for system health and readiness
 */

import { router, publicProcedure } from "../trpc.js";
import {
  sql,
  db,
  drizzleSql,
  getCatalogSyncStamps,
  type CatalogSyncStamp,
} from "@synap/database";

// Soft-degradation thresholds. Crossing these does NOT fail readiness (HTTP
// stays 200, status is unchanged) — they only populate the `degraded[]` reasons
// so a monitor can page BEFORE a green /health masks a dead dependency (the
// 2026-07-16 incident: embeddings died at 00:10, /health stayed green 14h).
const FAILED_JOB_DEGRADE_THRESHOLD = 200;
const PAST_DUE_JOB_DEGRADE_THRESHOLD = 500;
const EMBEDDING_STALE_MS = 24 * 60 * 60 * 1000;
/** A catalog kind whose last sync was this old counts as stale. */
const CATALOG_STALE_MS = 60 * 60 * 1000;

export interface QueueHealth {
  failed: number;
  pastDue: number;
}

/**
 * Aggregate pg-boss job health from the same `pgboss.job` table
 * `system.getQueueStats` reads. `failed` = failed-state backlog; `pastDue` =
 * `created` jobs whose `start_after` slipped more than an hour ago (a stalled
 * or unstaffed queue). Returns null if the query fails (pgboss not ready).
 */
async function readQueueHealth(): Promise<QueueHealth | null> {
  try {
    const rows = (await db.execute(drizzleSql`
      SELECT
        count(*) FILTER (WHERE state = 'failed')::int AS failed,
        count(*) FILTER (WHERE state = 'created'
          AND start_after < now() - interval '1 hour')::int AS past_due
      FROM pgboss.job
    `)) as unknown as Array<{ failed: number; past_due: number }>;
    const row = rows[0];
    return {
      failed: Number(row?.failed ?? 0),
      pastDue: Number(row?.past_due ?? 0),
    };
  } catch {
    return null;
  }
}

/** Newest `entity_vectors.updated_at`, or null when no rows / query fails. */
async function readEmbeddingFreshness(): Promise<Date | null> {
  try {
    const rows = (await db.execute(drizzleSql`
      SELECT max(updated_at) AS last FROM entity_vectors
    `)) as unknown as Array<{ last: string | Date | null }>;
    const last = rows[0]?.last;
    return last ? new Date(last) : null;
  } catch {
    return null;
  }
}

/** Catalog kinds whose last sync is empty/unreachable AND older than the stale window. */
function staleCatalogReasons(
  stamps: Record<string, CatalogSyncStamp>,
  now: number
): string[] {
  const reasons: string[] = [];
  for (const [key, stamp] of Object.entries(stamps)) {
    if (stamp.lastStatus === "ok") continue;
    const age = now - new Date(stamp.lastSyncAt).getTime();
    if (age > CATALOG_STALE_MS) {
      reasons.push(`catalog:${key}:${stamp.lastStatus}`);
    }
  }
  return reasons;
}

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
    const now = Date.now();
    const [checks, queueHealth, embeddingLast, catalogStamps] =
      await Promise.all([
        Promise.allSettled([checkDatabase(), checkJobQueue()]),
        readQueueHealth(),
        readEmbeddingFreshness(),
        getCatalogSyncStamps().catch(
          () => ({}) as Record<string, CatalogSyncStamp>
        ),
      ]);

    const databaseOk = checks[0].status === "fulfilled";
    const jobQueueOk = checks[1].status === "fulfilled";

    // Hard readiness — only DB + a live pg-boss singleton gate traffic. Kept
    // identical to preserve the existing "ready"/"degraded" contract.
    const allReady = databaseOk && jobQueueOk;

    // Soft degradation — additive signals that keep HTTP 200 / status unchanged
    // but tell a monitor a dependency is failing behind a green readiness probe.
    const degraded: string[] = [];
    if (queueHealth && queueHealth.failed > FAILED_JOB_DEGRADE_THRESHOLD) {
      degraded.push("queue:failed-backlog");
    }
    if (queueHealth && queueHealth.pastDue > PAST_DUE_JOB_DEGRADE_THRESHOLD) {
      degraded.push("queue:past-due-backlog");
    }
    if (embeddingLast && now - embeddingLast.getTime() > EMBEDDING_STALE_MS) {
      degraded.push("embeddings:stale");
    }
    degraded.push(...staleCatalogReasons(catalogStamps, now));

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
      // Additive fields (backward-compatible): soft-degradation reasons plus the
      // raw signals behind them, so a monitor can alarm without a second call.
      degraded,
      signals: {
        jobQueue: queueHealth,
        embeddings: {
          lastUpdatedAt: embeddingLast ? embeddingLast.toISOString() : null,
          stale: degraded.includes("embeddings:stale"),
        },
        catalogSync: catalogStamps,
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
