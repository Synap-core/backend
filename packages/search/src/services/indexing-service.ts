/**
 * Indexing Service
 * Handles queue management and bulk imports to Typesense
 */

import { getTypesenseClient } from "../client.js";
import { getDb } from "@synap/database";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@synap/database/schema";
import type { IndexingQueueItem } from "../types/index.js";
import {
  EntityIndexer,
  DocumentIndexer,
  ViewIndexer,
  ProjectIndexer,
  ChatThreadIndexer,
  AgentIndexer,
} from "../indexers/index.js";

export class IndexingService {
  private queue: Map<string, IndexingQueueItem[]> = new Map();

  private indexers = {
    entities: new EntityIndexer(),
    documents: new DocumentIndexer(),
    views: new ViewIndexer(),
    projects: new ProjectIndexer(),
    chat_threads: new ChatThreadIndexer(),
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
    const client = getTypesenseClient();
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

      case "projects":
        return db.query.projects.findMany({
          where: inArray(schema.projects.id, ids),
        });

      case "chat_threads":
        return db.query.chatThreads.findMany({
          where: inArray(schema.chatThreads.id, ids),
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
