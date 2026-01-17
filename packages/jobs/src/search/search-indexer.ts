/**
 * Search Indexer
 * Listens to .completed events and queues for indexing
 */

import { inngest } from "../client.js";
import { indexingService } from "@synap/search";

export const searchIndexer = inngest.createFunction(
  {
    id: "search-indexer",
    name: "Search Indexer - Event Listener",
    retries: 3,
  },
  // Listen to all .completed events
  [
    { event: "entities.*.completed" },
    { event: "documents.*.completed" },
    { event: "views.*.completed" },
    { event: "projects.*.completed" },
    { event: "chat_threads.*.completed" },
    { event: "agents.*.completed" },
  ],
  async ({ event, step }) => {
    return await step.run("queue-for-indexing", async () => {
      // Parse event type
      const [table, operation, _] = event.name.split(".");

      // Map table to collection
      const collectionMap: Record<string, string> = {
        entities: "entities",
        documents: "documents",
        views: "views",
        projects: "projects",
        chat_threads: "chat_threads",
        agents: "agents",
      };

      const collection = collectionMap[table];
      if (!collection) {
        return { status: "skipped", reason: "Unknown table", table };
      }

      // Queue for bulk indexing
      await indexingService.queueIndexing({
        collection,
        operation: operation === "delete" ? "delete" : "upsert",
        documentId: event.data.id,
        timestamp: Date.now(),
      });

      return {
        status: "queued",
        collection,
        documentId: event.data.id,
        operation,
      };
    });
  }
);
