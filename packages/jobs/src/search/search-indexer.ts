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
  // Listen to .completed events using trailing wildcards (Inngest-compatible)
  [
    { event: "entity.*" },
    { event: "document.*" },
    { event: "view.*" },
    { event: "chatThread.*" },
    { event: "agent.*" },
  ],
  async ({ event, step }) => {
    return await step.run("queue-for-indexing", async () => {
      // Parse event type: {subjectType}.{action}.{phase}
      const [subjectType, operation, phase] = event.name.split(".");

      // Only index on completed events
      if (phase !== "completed") {
        return { status: "skipped", reason: "Not a completed event", phase };
      }

      // Map singular subject type to Typesense collection name
      const collectionMap: Record<string, string> = {
        entity: "entities",
        document: "documents",
        view: "views",
        chatThread: "chat_threads",
        agent: "agents",
      };

      const collection = collectionMap[subjectType];
      if (!collection) {
        return {
          status: "skipped",
          reason: "Unknown subject type",
          subjectType,
        };
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
