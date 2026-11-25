/**
 * Vector Index Rebuild Cron Worker
 *
 * Periodically rebuilds the vector index by enqueueing entity-embedding jobs
 * for all live entities. Runs weekly to catch any entities that missed embedding
 * generation (provider outages, worker crashes, schema changes).
 *
 * Scheduled via pg-boss cron: every Sunday at 03:00 UTC (configurable).
 */

import { sql } from "@synap/database";
import { getBoss } from "@synap/events";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "vector-index-rebuild" });

/**
 * Configuration for the vector index rebuild.
 * - BATCH_SIZE: Entities per job batch (avoids memory pressure)
 * - DEBOUNCE_SECONDS: Per-entity singleton debounce to avoid double-enqueue
 * - CRON_SCHEDULE: When to run (default: weekly Sunday 03:00 UTC)
 */
const DEBOUNCE_SECONDS = 60;
const CRON_SCHEDULE = "0 3 * * 0"; // Weekly Sunday 03:00 UTC

/**
 * Enqueue embedding jobs for entities without vectors, or all entities if reembedAll.
 */
async function enqueueRebuild(reembedAll = false): Promise<number> {
  logger.info({ reembedAll }, "Vector index rebuild started");

  const rows = (await sql`
    SELECT e.id, e.user_id
    FROM entities e
    LEFT JOIN entity_vectors ev ON ev.entity_id = e.id
    WHERE e.deleted_at IS NULL
      ${reembedAll ? sql`` : sql`AND ev.entity_id IS NULL`}
  `) as { id: string; user_id: string }[];

  logger.info({ count: rows.length }, "Found entities to enqueue");

  if (rows.length === 0) {
    logger.info("No entities need embedding");
    return 0;
  }

  const boss = getBoss();

  // Batch send with controlled concurrency to avoid overwhelming pg-boss
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
            singletonSeconds: DEBOUNCE_SECONDS,
          }
        );
      })
    );
    enqueued += batch.length;
    logger.debug({ enqueued, total: rows.length }, "Batch enqueued");
  }

  logger.info({ enqueued }, "Vector index rebuild enqueued");
  return enqueued;
}

/**
 * Main handler - runs on cron schedule.
 */
export async function handleVectorIndexRebuild(): Promise<void> {
  const startTime = Date.now();
  try {
    const count = await enqueueRebuild(false); // Only missing vectors by default
    const duration = Date.now() - startTime;
    logger.info(
      { count, durationMs: duration },
      "Vector index rebuild completed"
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      { err: error, durationMs: duration },
      "Vector index rebuild failed"
    );
    throw error;
  }
}

/**
 * Full re-embed handler - for manual recovery after provider/schema changes.
 * Not on cron - invoked manually via `pnpm --filter @synap/jobs vector-index-rebuild -- --all`
 */
export async function handleFullVectorReembed(): Promise<void> {
  const startTime = Date.now();
  try {
    const count = await enqueueRebuild(true);
    const duration = Date.now() - startTime;
    logger.info(
      { count, durationMs: duration },
      "Full vector re-embed completed"
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error(
      { err: error, durationMs: duration },
      "Full vector re-embed failed"
    );
    throw error;
  }
}

// CLI entry point
const isMainModule = require.main === module;
if (isMainModule) {
  const reembedAll = process.argv.includes("--all");
  const handler = reembedAll
    ? handleFullVectorReembed
    : handleVectorIndexRebuild;
  handler()
    .then(() => {
      console.log("\n✨ Done!");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n💥 Fatal error:", error);
      process.exit(1);
    });
}

export const VECTOR_INDEX_REBUILD_CRON = CRON_SCHEDULE;
export { CRON_SCHEDULE };
