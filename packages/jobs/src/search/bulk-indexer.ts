/**
 * Bulk Indexer
 * Scheduled function to flush queue every 10 seconds
 */

import { inngest } from "../client.js";
import { indexingService } from "@synap/search";

export const bulkIndexer = inngest.createFunction(
  {
    id: "bulk-indexer",
    name: "Bulk Indexer - Queue Flusher",
  },
  // Run every 10 seconds
  { cron: "*/10 * * * * *" },
  async ({ step }) => {
    return await step.run("flush-indexing-queue", async () => {
      // Get queue status before flushing
      const queueStatus = indexingService.getQueueStatus();
      const totalItems = Object.values(queueStatus).reduce(
        (sum, count) => sum + count,
        0
      );

      if (totalItems === 0) {
        return {
          status: "skipped",
          reason: "Queue is empty",
          timestamp: new Date().toISOString(),
        };
      }

      // Flush queue
      const results = await indexingService.flushQueue();

      return {
        status: "flushed",
        queuedItems: totalItems,
        results,
        timestamp: new Date().toISOString(),
      };
    });
  }
);
