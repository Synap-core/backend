/**
 * Embedding Pipeline Health Check Cron Worker
 *
 * Monitors the embedding pipeline health and alerts when degraded.
 * Runs every 5 minutes to catch issues early.
 *
 * Checks:
 * 1. entity-embedding queue health (failed/completed ratio in window)
 * 2. entity_vectors freshness (last successful write)
 * 3. IS embedding endpoint reachability
 */

import { sql, db, drizzleSql } from "@synap/database";
import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";
import { resolveDefaultIntelligenceEndpoint } from "@synap/database";

const logger = createLogger({ module: "embedding-pipeline-health" });

// Configuration
const HEALTH_CHECK_CRON = "*/5 * * * *"; // Every 5 minutes
const EMBEDDING_QUEUE = "entity-embedding";
const FAILURE_WINDOW_MINUTES = 15;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const FAILED_RATIO_THRESHOLD = 0.5; // Alert if failed >= completed in window
const RECOVERY_CONFIRMATION_CHECKS = 2; // Require 2 consecutive healthy checks before triggering recovery

// Cache for IS endpoint resolution (TTL: 5 minutes)
let cachedEndpoint: {
  endpoint: string;
  apiKey: string;
  cachedAt: number;
} | null = null;
const ENDPOINT_CACHE_TTL_MS = 5 * 60 * 1000;

interface QueueHealthCheck {
  readable: boolean;
  recentFailed: number;
  recentCompleted: number;
  failedRatio: number;
  healthy: boolean;
}

interface VectorFreshnessCheck {
  lastUpdatedAt: string | null;
  ageMs: number | null;
  healthy: boolean;
}

interface ISReachabilityCheck {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  healthy: boolean;
}

interface HealthCheckResult {
  healthy: boolean;
  checks: {
    queueHealth: QueueHealthCheck;
    vectorFreshness: VectorFreshnessCheck;
    isReachability: ISReachabilityCheck;
  };
  degradedReasons: string[];
  recoveryTriggered: boolean;
}

interface RecoveryState {
  lastHealthyState: boolean | null;
  consecutiveHealthyChecks: number;
  updatedAt: string;
}

/**
 * Get the intelligence service endpoint with caching (5 min TTL).
 */
async function getCachedEndpoint(): Promise<{
  endpoint: string;
  apiKey: string;
}> {
  const now = Date.now();
  if (cachedEndpoint && now - cachedEndpoint.cachedAt < ENDPOINT_CACHE_TTL_MS) {
    return { endpoint: cachedEndpoint.endpoint, apiKey: cachedEndpoint.apiKey };
  }
  const { endpoint, apiKey } = await resolveDefaultIntelligenceEndpoint();
  cachedEndpoint = { endpoint, apiKey, cachedAt: now };
  return { endpoint, apiKey };
}

/**
 * Persist recovery state to database for multi-process safety.
 */
async function getRecoveryState(): Promise<RecoveryState> {
  try {
    const rows = (await sql`
      SELECT result FROM intelligence_health_checks
      WHERE check_type = 'embedding_pipeline_recovery'
      ORDER BY checked_at DESC
      LIMIT 1
    `) as unknown as Array<{ result: RecoveryState }>;
    if (rows.length > 0 && rows[0].result) {
      return rows[0].result;
    }
  } catch {
    // Table might not exist or query fails
  }
  return {
    lastHealthyState: null,
    consecutiveHealthyChecks: 0,
    updatedAt: new Date().toISOString(),
  };
}

async function saveRecoveryState(state: RecoveryState): Promise<void> {
  await sql`
    INSERT INTO intelligence_health_checks (check_type, result, checked_at)
    VALUES ('embedding_pipeline_recovery', ${JSON.stringify(state)}, NOW())
    ON CONFLICT (check_type) DO UPDATE SET
      result = EXCLUDED.result,
      checked_at = NOW()
  `;
}

async function checkQueueHealth(): Promise<QueueHealthCheck> {
  try {
    const rows = (await db.execute(drizzleSql`
      SELECT
        count(*) FILTER (WHERE state = 'failed')::int AS recent_failed,
        count(*) FILTER (WHERE state = 'completed')::int AS recent_completed
      FROM pgboss.job
      WHERE name = ${EMBEDDING_QUEUE}
        AND completed_on > now() - (${FAILURE_WINDOW_MINUTES}::int * interval '1 minute')
    `)) as unknown as Array<{
      recent_failed: number;
      recent_completed: number;
    }>;

    const row = rows[0];
    const recentFailed = Number(row?.recent_failed ?? 0);
    const recentCompleted = Number(row?.recent_completed ?? 0);
    const total = recentFailed + recentCompleted;
    const failedRatio = total > 0 ? recentFailed / total : 0;

    return {
      readable: true,
      recentFailed,
      recentCompleted,
      failedRatio,
      healthy: total === 0 || failedRatio < FAILED_RATIO_THRESHOLD,
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to read embedding queue health");
    return {
      readable: false,
      recentFailed: 0,
      recentCompleted: 0,
      failedRatio: 0,
      healthy: false,
    };
  }
}

async function checkVectorFreshness(): Promise<VectorFreshnessCheck> {
  try {
    const rows = (await db.execute(drizzleSql`
      SELECT max(updated_at) AS last FROM entity_vectors
    `)) as unknown as Array<{ last: string | Date | null }>;

    const last = rows[0]?.last;
    if (!last) {
      return {
        lastUpdatedAt: null,
        ageMs: null,
        healthy: false,
      };
    }

    const lastUpdated = new Date(last);
    const ageMs = Date.now() - lastUpdated.getTime();

    return {
      lastUpdatedAt: lastUpdated.toISOString(),
      ageMs,
      healthy: ageMs < STALE_THRESHOLD_MS,
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to read vector freshness");
    return {
      lastUpdatedAt: null,
      ageMs: null,
      healthy: false,
    };
  }
}

async function checkISReachability(): Promise<ISReachabilityCheck> {
  const startTime = Date.now();
  try {
    const { endpoint, apiKey } = await getCachedEndpoint();
    const response = await fetch(`${endpoint}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({ text: "health check" }),
      signal: AbortSignal.timeout(5000),
    });

    const latencyMs = Date.now() - startTime;
    const reachable = response.ok;

    if (!reachable) {
      const errorText = (await response.text().catch(() => "")).slice(0, 200);
      return {
        reachable: false,
        latencyMs,
        error: `HTTP ${response.status}: ${errorText}`,
        healthy: false,
      };
    }

    return {
      reachable: true,
      latencyMs,
      error: null,
      healthy: true,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);
    return {
      reachable: false,
      latencyMs,
      error: message,
      healthy: false,
    };
  }
}

async function recordHealthCheck(result: HealthCheckResult): Promise<void> {
  // Store the health check result for history/trending
  await sql`
    INSERT INTO intelligence_health_checks (check_type, result, checked_at)
    VALUES ('embedding_pipeline', ${JSON.stringify(result)}, NOW())
    ON CONFLICT (check_type, checked_at) DO NOTHING
  `;
}

export async function handleEmbeddingPipelineHealthCheck(): Promise<void> {
  const startTime = Date.now();

  try {
    // Load persisted recovery state
    const recoveryState = await getRecoveryState();
    let { lastHealthyState, consecutiveHealthyChecks } = recoveryState;

    const [queueHealth, vectorFreshness, isReachability] = await Promise.all([
      checkQueueHealth(),
      checkVectorFreshness(),
      checkISReachability(),
    ]);

    const degradedReasons: string[] = [];

    if (!queueHealth.readable) {
      degradedReasons.push("embeddings:queue_unreadable");
    } else if (!queueHealth.healthy) {
      degradedReasons.push(
        `embeddings:queue_failing (${(queueHealth.failedRatio * 100).toFixed(1)}% failed)`
      );
    }

    if (!vectorFreshness.healthy) {
      if (vectorFreshness.ageMs === null) {
        degradedReasons.push("embeddings:no_vectors");
      } else {
        const hours = Math.round(vectorFreshness.ageMs! / (60 * 60 * 1000));
        degradedReasons.push(`embeddings:stale (${hours}h since last write)`);
      }
    }

    if (!isReachability.healthy) {
      degradedReasons.push(
        `embeddings:is_unreachable (${isReachability.error})`
      );
    }

    const isHealthy = degradedReasons.length === 0;

    // Recovery detection: track state transitions (using persisted state)
    let recoveryTriggered = false;
    if (isHealthy) {
      consecutiveHealthyChecks++;
      if (
        lastHealthyState === false &&
        consecutiveHealthyChecks >= RECOVERY_CONFIRMATION_CHECKS
      ) {
        // Pipeline just recovered from degraded state
        logger.info(
          { consecutiveHealthyChecks },
          "Embedding pipeline RECOVERED — triggering re-embedding sweep for stale vectors"
        );
        await triggerRecoveryReembedding();
        recoveryTriggered = true;
        consecutiveHealthyChecks = 0; // Reset counter after triggering
      }
    } else {
      consecutiveHealthyChecks = 0; // Reset on any degraded check
    }
    lastHealthyState = isHealthy;

    // Persist updated recovery state
    await saveRecoveryState({
      lastHealthyState,
      consecutiveHealthyChecks,
      updatedAt: new Date().toISOString(),
    });

    const result: HealthCheckResult = {
      healthy: isHealthy,
      checks: {
        queueHealth,
        vectorFreshness,
        isReachability,
      },
      degradedReasons,
      recoveryTriggered,
    };

    // Record for history
    await recordHealthCheck(result);

    // Log the result
    if (isHealthy) {
      logger.info(
        { durationMs: Date.now() - startTime, recoveryTriggered },
        "Embedding pipeline health check: HEALTHY"
      );
    } else {
      logger.warn(
        {
          degradedReasons: result.degradedReasons,
          durationMs: Date.now() - startTime,
        },
        "Embedding pipeline health check: DEGRADED"
      );
    }
  } catch (error) {
    logger.error(
      { err: error, durationMs: Date.now() - startTime },
      "Embedding pipeline health check failed"
    );
    throw error;
  }
}

/**
 * Trigger a re-embedding sweep for entities with stale or missing vectors.
 * Enqueues entity-embedding jobs for entities where vectors are >24h old or missing.
 */
async function triggerRecoveryReembedding(): Promise<void> {
  try {
    const rows = (await sql`
      SELECT e.id, e.user_id
      FROM entities e
      LEFT JOIN entity_vectors ev ON ev.entity_id = e.id
      WHERE e.deleted_at IS NULL
        AND (ev.entity_id IS NULL OR ev.updated_at < NOW() - INTERVAL '24 hours')
    `) as { id: string; user_id: string }[];

    if (rows.length === 0) {
      logger.info("Recovery re-embedding: no stale/missing vectors found");
      return;
    }

    logger.info(
      { count: rows.length },
      "Triggering recovery re-embedding sweep"
    );

    const boss = getBoss();
    const CONCURRENCY = 50;
    let enqueued = 0;

    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (row) => {
          await boss.send(
            "entity-embedding",
            { entityId: row.id, userId: row.user_id },
            {
              singletonKey: `entity-embedding:${row.id}`,
              singletonSeconds: 60,
            }
          );
        })
      );
      enqueued += batch.length;
      logger.debug({ enqueued, total: rows.length }, "Recovery batch enqueued");
    }

    logger.info({ enqueued }, "Recovery re-embedding sweep enqueued");
  } catch (error) {
    logger.error({ err: error }, "Failed to trigger recovery re-embedding");
    // Don't throw — recovery is best-effort
  }
}

export const EMBEDDING_PIPELINE_HEALTH_CRON = HEALTH_CHECK_CRON;
