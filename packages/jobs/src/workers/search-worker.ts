/**
 * Search Worker
 *
 * Handles search indexing via Typesense.
 * Ported from Inngest functions: search-indexer.ts + bulk-indexer.ts
 */

import type PgBoss from "pg-boss";
import { indexingService } from "@synap/search";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "search-worker" });

/**
 * Handle individual search index requests.
 *
 * Calls indexNow() for immediate Typesense upsert/delete so that newly
 * created/updated items are searchable within seconds. The bulk-index cron
 * (search-bulk-index) handles any items that slipped through (e.g. Typesense
 * was temporarily unavailable) by re-queuing and flushing.
 */
export async function handleSearchIndex(
  job: PgBoss.Job<{
    collection: string;
    operation: "upsert" | "delete";
    documentId: string;
    timestamp: number;
  }>
): Promise<void> {
  const { collection, operation, documentId, timestamp } = job.data;

  try {
    await indexingService.indexNow({
      collection,
      operation,
      documentId,
      timestamp,
    });
    logger.debug(
      { collection, operation, documentId },
      "Indexed immediately via indexNow"
    );
  } catch (err) {
    // If immediate indexing fails (Typesense down), fall back to queue so the
    // bulk cron can retry later.
    logger.warn(
      { err, collection, documentId },
      "indexNow failed — falling back to queue"
    );
    await indexingService.queueIndexing({
      collection,
      operation,
      documentId,
      timestamp,
    });
  }
}

/**
 * Flush the search indexing queue (cron).
 * Runs periodically to process bulk index operations.
 */
export async function handleBulkIndex(): Promise<void> {
  const queueStatus = indexingService.getQueueStatus();
  const totalItems = Object.values(queueStatus).reduce(
    (sum: number, count: number) => sum + count,
    0
  );

  if (totalItems === 0) {
    return;
  }

  const results = await indexingService.flushQueue();
  logger.info({ totalItems, results }, "Flushed search indexing queue");
}

/**
 * Full reindex: sync all live DB records into Typesense and prune stale docs.
 * Called by the `search-reindex` pg-boss job (admin-triggered).
 */
export async function handleFullReindex(job: PgBoss.Job<{ collections?: string[] }>): Promise<void> {
  const { collections } = job.data ?? {};
  logger.info({ collections }, "Starting full search reindex");
  const results = await indexingService.fullReindex(collections);
  logger.info({ results }, "Full search reindex complete");
}
