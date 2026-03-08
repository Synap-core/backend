/**
 * Indexing Service
 * Handles queue management and bulk imports to Typesense
 */

import { getTypesenseAdminClient } from "../client.js";
import { getDb, inArray } from "@synap/database";
import * as schema from "@synap/database/schema";
import type { IndexingQueueItem } from "../types/index.js";
import {
  EntityIndexer,
  DocumentIndexer,
  ViewIndexer,
  ChannelIndexer,
  AgentIndexer,
} from "../indexers/index.js";

export class IndexingService {
  private queue: Map<string, IndexingQueueItem[]> = new Map();

  private indexers = {
    entities: new EntityIndexer(),
    documents: new DocumentIndexer(),
    views: new ViewIndexer(),
    channels: new ChannelIndexer(),
    agents: new AgentIndexer(),
  };

  /**
   * Add item to indexing queue
   */
  async queueIndexing(item: IndexingQueueItem): Promise<void> {
    const key = item.collection;
    if (!this.queue.has(key)) {
      this.queue.set(key, []);
    }
    this.queue.get(key)!.push(item);

    // Auto-flush if queue gets too large
    const totalSize = Array.from(this.queue.values()).reduce(
      (sum, items) => sum + items.length,
      0
    );
    if (totalSize > 1000) {
      console.warn("Queue size exceeded 1000, auto-flushing...");
      await this.flushQueue();
    }
  }

  /**
   * Flush queue and perform bulk import
   * Called by scheduled Inngest function every 10 seconds
   */
  async flushQueue(): Promise<Record<string, any>> {
    const client = getTypesenseAdminClient();
    const results: Record<string, any> = {};

    for (const [collection, items] of this.queue.entries()) {
      if (items.length === 0) continue;

      try {
        // Separate upserts and deletes
        const upserts = items.filter((i) => i.operation === "upsert");
        const deletes = items.filter((i) => i.operation === "delete");

        // Perform bulk upsert
        if (upserts.length > 0) {
          const indexer =
            this.indexers[collection as keyof typeof this.indexers];
          if (!indexer) {
            console.error(`No indexer found for collection: ${collection}`);
            continue;
          }

          const documents = await this.fetchDocuments(
            collection,
            upserts.map((i) => i.documentId)
          );
          const searchDocs = await indexer.toSearchDocuments(documents);

          const importResult = await client
            .collections(collection)
            .documents()
            .import(searchDocs, { action: "upsert" });

          const successCount = importResult.filter(
            (r: any) => r.success
          ).length;
          const failedCount = importResult.filter(
            (r: any) => !r.success
          ).length;

          results[collection] = {
            upserted: successCount,
            failed: failedCount,
          };

          if (failedCount > 0) {
            console.error(
              `Failed to index ${failedCount} documents in ${collection}`
            );
          }
        }

        // Perform bulk delete
        if (deletes.length > 0) {
          const deleteIds = deletes.map((d) => d.documentId);

          // Delete one by one (Typesense doesn't have bulk delete by ID)
          let deletedCount = 0;
          for (const id of deleteIds) {
            try {
              await client.collections(collection).documents(id).delete();
              deletedCount++;
            } catch (error) {
              // Document might not exist, ignore
              console.warn(
                `Failed to delete document ${id} from ${collection}:`,
                error
              );
            }
          }

          results[collection] = {
            ...results[collection],
            deleted: deletedCount,
          };
        }

        // Clear queue for this collection
        this.queue.set(collection, []);
      } catch (error) {
        console.error(`Error flushing queue for ${collection}:`, error);
        results[collection] = {
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }

    return results;
  }

  /**
   * Fetch documents from database
   */
  private async fetchDocuments(
    collection: string,
    ids: string[]
  ): Promise<any[]> {
    const db = await getDb();

    switch (collection) {
      case "entities":
        return db.query.entities.findMany({
          where: inArray(schema.entities.id, ids),
        });

      case "documents":
        return db.query.documents.findMany({
          where: inArray(schema.documents.id, ids),
        });

      case "views":
        return db.query.views.findMany({
          where: inArray(schema.views.id, ids),
        });

      case "channels":
        return db.query.channels.findMany({
          where: inArray(schema.channels.id, ids),
        });

      case "agents":
        return db.query.agents.findMany({
          where: inArray(schema.agents.id, ids),
        });

      default:
        throw new Error(`Unknown collection: ${collection}`);
    }
  }

  /**
   * Immediately index a single item without queuing.
   *
   * Used by the per-item search-index job handler so newly created/updated
   * entities, documents, and views appear in Typesense within seconds rather
   * than waiting for the 30-minute bulk flush cron.
   */
  async indexNow(item: IndexingQueueItem): Promise<void> {
    const client = getTypesenseAdminClient();

    if (item.operation === "delete") {
      try {
        await client
          .collections(item.collection)
          .documents(item.documentId)
          .delete();
      } catch {
        // Document may not exist in Typesense — not an error
      }
      return;
    }

    const indexer =
      this.indexers[item.collection as keyof typeof this.indexers];
    if (!indexer) {
      console.error(`[indexNow] No indexer for collection: ${item.collection}`);
      return;
    }

    const records = await this.fetchDocuments(item.collection, [
      item.documentId,
    ]);
    if (records.length === 0) {
      // Record was deleted before indexing — remove from Typesense if present
      try {
        await client
          .collections(item.collection)
          .documents(item.documentId)
          .delete();
      } catch {
        // Not found — fine
      }
      return;
    }

    const searchDocs = await indexer.toSearchDocuments(records);
    if (searchDocs.length === 0) return;

    await client
      .collections(item.collection)
      .documents()
      .import(searchDocs, { action: "upsert" });
  }

  /**
   * Get queue status
   */
  getQueueStatus(): Record<string, number> {
    const status: Record<string, number> = {};
    for (const [collection, items] of this.queue.entries()) {
      status[collection] = items.length;
    }
    return status;
  }
}

export const indexingService = new IndexingService();
