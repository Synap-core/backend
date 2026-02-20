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
 * Queues the item for bulk indexing.
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

  await indexingService.queueIndexing({
    collection,
    operation,
    documentId,
    timestamp,
  });

  logger.debug({ collection, operation, documentId }, "Queued for search indexing");
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
