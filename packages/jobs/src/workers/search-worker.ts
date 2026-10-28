/**
 * Search Worker
 *
 * Handles search indexing via Typesense.
 * Ported from Inngest functions: search-indexer.ts + bulk-indexer.ts
 */

import type PgBoss from "pg-boss";
import {
  indexingService,
  collectionsBehind,
  readSearchIndexVersions,
  stampSearchIndexVersion,
  SEARCH_INDEX_VERSIONS,
} from "@synap/search";
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
 * Called by the `search-reindex` pg-boss job (admin-triggered, or enqueued at
 * boot by `enqueueSearchReindexIfBehind`). A collection that reindexed with no
 * error is stamped at its current index version.
 */
export async function handleFullReindex(
  job: PgBoss.Job<{ collections?: string[] }>
): Promise<void> {
  const { collections } = job.data ?? {};
  logger.info({ collections }, "Starting full search reindex");
  const results = await indexingService.fullReindex(collections);
  logger.info({ results }, "Full search reindex complete");

  for (const [collection, result] of Object.entries(results)) {
    if (result.error || !(collection in SEARCH_INDEX_VERSIONS)) continue;
    try {
      await stampSearchIndexVersion(collection);
    } catch (err) {
      // Unstamped ⇒ the next boot reindexes it again: wasted work, not a loss.
      logger.warn({ err, collection }, "Could not stamp search index version");
    }
  }
}

/** The singleton key of the boot reindex, so several booting workers queue one. */
export const SEARCH_INDEX_VERSION_SINGLETON = "search-index-version";

/**
 * At boot: when this pod's search index predates the indexer (a collection's
 * stamped version is below `SEARCH_INDEX_VERSIONS`), enqueue ONE full reindex
 * of the collections behind. Without it, an indexer change reaches only the
 * rows written after the deploy. Returns the collections it queued.
 */
export async function enqueueSearchReindexIfBehind(
  boss: Pick<PgBoss, "send">
): Promise<string[]> {
  const behind = collectionsBehind(await readSearchIndexVersions());
  if (behind.length === 0) return [];
  await boss.send(
    "search-reindex",
    { collections: behind },
    { singletonKey: SEARCH_INDEX_VERSION_SINGLETON }
  );
  logger.info(
    { collections: behind },
    "Search index is behind the indexer — full reindex queued"
  );
  return behind;
}
