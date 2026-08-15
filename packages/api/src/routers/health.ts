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

/**
 * The pg-boss queue that owns the POD side of the embedding pipeline: call the
 * IS `/api/embeddings`, then `INSERT INTO entity_vectors … ::vector`.
 * (`packages/jobs/src/workers/entity-embedding.ts`.)
 */
const EMBEDDING_QUEUE = "entity-embedding";

/**
 * Window for the pod-side embedding OUTCOME signal.
 *
 * It MUST be a window, not a lifetime count: pg-boss keeps failed rows in
 * `pgboss.job` for 7 days (`archiveCompletedAfterSeconds`), so `count(*) WHERE
 * state='failed'` is a week-long cumulative counter — a check built on it goes
 * red once and stays red, which is the always-red trap. Scoping on
 * `completed_on` inside this window means the signal DECAYS on its own: 15
 * quiet minutes and it is green again, with no reset step and no watermark.
 */
const EMBEDDING_FAILURE_WINDOW_MINUTES = 15;

export interface QueueHealth {
  failed: number;
  pastDue: number;
}

/**
 * The pod-side embedding-pipeline outcome — the half the IS structurally CANNOT
 * see.
 *
 * The IS `/health` `checks.embeddings` reports the last outcome of an IS-side
 * PROVIDER call. That is a real signal, but it is blind to everything that
 * happens on this side of the wire, and every one of these is a total recall
 * outage that leaves the IS reporting `embeddings: ok`:
 *   • the pod cannot reach the IS at all (endpoint/key misresolved, 401, DNS),
 *   • the pgvector write fails (extension missing, dimension mismatch, the
 *     `::vector` cast throwing),
 *   • the queue is unstaffed and nothing runs.
 * The IS cannot report any of them from where it sits — so the POD reports
 * them, from the outcome ledger it already owns. No proxy signal, no probe, no
 * new table: the job rows are the evidence.
 *
 * `readable:false` means the QUERY ITSELF failed. That is deliberately distinct
 * from "zero failures": the previous code returned null on catch and the caller
 * silently pushed no reason, so a broken pgboss schema read as perfect health.
 */
export interface EmbeddingPipelineHealth {
  readable: boolean;
  recentFailed: number;
  recentCompleted: number;
  windowMinutes: number;
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

/**
 * Windowed per-queue outcome for `entity-embedding` (see
 * EmbeddingPipelineHealth). PER-QUEUE on purpose: the fleet-wide
 * `FAILED_JOB_DEGRADE_THRESHOLD = 200` above cannot see a completely dead
 * embedding pipeline, because a stone-dead queue produces far fewer than 200
 * failures — reading the TOTAL instead of the per-queue split is the same shape
 * of blindness the IS hit reading total free pool slots.
 *
 * `pgboss.job` is `PARTITION BY LIST (name)` in pg-boss 10.4.2, so the `name`
 * predicate prunes to this queue's partition. A terminal failure sets
 * `completed_on = now()` (plans.js `failJobs`), which is what makes the window
 * work.
 */
async function readEmbeddingPipeline(): Promise<EmbeddingPipelineHealth> {
  const windowMinutes = EMBEDDING_FAILURE_WINDOW_MINUTES;
  try {
    const rows = (await db.execute(drizzleSql`
      SELECT
        count(*) FILTER (WHERE state = 'failed')::int AS recent_failed,
        count(*) FILTER (WHERE state = 'completed')::int AS recent_completed
      FROM pgboss.job
      WHERE name = ${EMBEDDING_QUEUE}
        AND completed_on > now() - (${windowMinutes}::int * interval '1 minute')
    `)) as unknown as Array<{
      recent_failed: number;
      recent_completed: number;
    }>;
    const row = rows[0];
    return {
      readable: true,
      recentFailed: Number(row?.recent_failed ?? 0),
      recentCompleted: Number(row?.recent_completed ?? 0),
      windowMinutes,
    };
  } catch {
    return {
      readable: false,
      recentFailed: 0,
      recentCompleted: 0,
      windowMinutes,
    };
  }
}

/**
 * Readiness probes fire at LB/orchestrator frequency; the two soft-signal
 * aggregates above scan pgboss.job and entity_vectors (no updated_at index),
 * so their results are memoized for a minute — staleness signals measured in
 * hours don't need per-probe freshness, and the probe must never become its
 * own load source (review finding S2).
 */
const SIGNAL_CACHE_MS = 60_000;
let signalCache: {
  at: number;
  queue: QueueHealth | null;
  freshness: Date | null;
  pipeline: EmbeddingPipelineHealth;
} | null = null;

async function readSoftSignals(): Promise<{
  queue: QueueHealth | null;
  freshness: Date | null;
  pipeline: EmbeddingPipelineHealth;
}> {
  const now = Date.now();
  if (signalCache && now - signalCache.at < SIGNAL_CACHE_MS) {
    const { queue, freshness, pipeline } = signalCache;
    return { queue, freshness, pipeline };
  }
  const [queue, freshness, pipeline] = await Promise.all([
    readQueueHealth(),
    readEmbeddingFreshness(),
    readEmbeddingPipeline(),
  ]);
  signalCache = { at: now, queue, freshness, pipeline };
  return { queue, freshness, pipeline };
}

/**
 * PURE: the soft-degradation reasons for the embedding pipeline. DB-free so the
 * decay contract is unit-testable.
 *
 * What makes each reason go GREEN again — every one decays on its own, none
 * needs a reset:
 *  • `embeddings:failing` — the failures age out of the
 *    EMBEDDING_FAILURE_WINDOW_MINUTES window, or successes start outnumbering
 *    them. A quiet queue (0 failed, 0 completed) is NOT failing.
 *  • `embeddings:unreadable` — the next successful read of `pgboss.job` clears
 *    it. This reason exists because "the query threw" previously produced
 *    silence, which read as health.
 *  • `embeddings:stale` — the next successful `entity_vectors` write. Requires
 *    a KNOWN last-write time; a null (empty table / unreadable) never fabricates
 *    staleness, it reports `embeddings:unreadable` when the read itself failed.
 */
export function embeddingDegradeReasons(
  pipeline: EmbeddingPipelineHealth,
  lastVectorWriteAt: Date | null,
  now: number
): string[] {
  const reasons: string[] = [];
  if (!pipeline.readable) {
    reasons.push("embeddings:unreadable");
  } else if (
    pipeline.recentFailed > 0 &&
    pipeline.recentFailed >= pipeline.recentCompleted
  ) {
    // Failing at least as often as it succeeds, inside the window. A pipeline
    // that fails a few jobs while succeeding at many is retrying, not down.
    reasons.push("embeddings:failing");
  }
  if (
    lastVectorWriteAt &&
    now - lastVectorWriteAt.getTime() > EMBEDDING_STALE_MS
  ) {
    reasons.push("embeddings:stale");
  }
  return reasons;
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
    const [checks, softSignals, catalogStamps] = await Promise.all([
      Promise.allSettled([checkDatabase(), checkJobQueue()]),
      readSoftSignals(),
      getCatalogSyncStamps().catch(
        () => ({}) as Record<string, CatalogSyncStamp>
      ),
    ]);
    const {
      queue: queueHealth,
      freshness: embeddingLast,
      pipeline: embeddingPipeline,
    } = softSignals;

    const databaseOk = checks[0].status === "fulfilled";
    const jobQueueOk = checks[1].status === "fulfilled";

    // Hard readiness — only DB + a live pg-boss singleton gate traffic. Kept
    // identical to preserve the existing "ready"/"degraded" contract.
    const allReady = databaseOk && jobQueueOk;

    // Soft degradation — additive signals that keep HTTP 200 / status unchanged
    // but tell a monitor a dependency is failing behind a green readiness probe.
    const degraded: string[] = [];
    // A NULL queueHealth means the aggregate query FAILED. It used to produce
    // no reason at all — an unreadable queue read as a healthy queue. Say so.
    if (!queueHealth) {
      degraded.push("queue:unreadable");
    }
    if (queueHealth && queueHealth.failed > FAILED_JOB_DEGRADE_THRESHOLD) {
      degraded.push("queue:failed-backlog");
    }
    if (queueHealth && queueHealth.pastDue > PAST_DUE_JOB_DEGRADE_THRESHOLD) {
      degraded.push("queue:past-due-backlog");
    }
    degraded.push(
      ...embeddingDegradeReasons(embeddingPipeline, embeddingLast, now)
    );
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
          // The pod-side OUTCOME of the embedding pipeline — the half the IS
          // /health cannot observe (see EmbeddingPipelineHealth). `readable`
          // false means this pod could not read its own job ledger, which is
          // reported, never swallowed.
          pipeline: embeddingPipeline,
          failing: degraded.includes("embeddings:failing"),
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
