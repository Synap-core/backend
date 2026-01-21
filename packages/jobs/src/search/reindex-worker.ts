/**
 * Reindex Worker
 * Manual reindex job for workspace or specific collections
 */

import { inngest } from "../client.js";
import { indexingService, collectionService } from "@synap/search";
import { getDb } from "@synap/database";
import * as schema from "@synap/database/schema";
import { eq } from "drizzle-orm";

export const reindexWorker = inngest.createFunction(
  {
    id: "reindex-worker",
    name: "Reindex Worker - Full Reindex",
    retries: 1,
  },
  { event: "search.reindex.requested" },
  async ({ event, step }) => {
    const { workspaceId, collections } = event.data;

    // Initialize collections if needed
    await step.run("initialize-collections", async () => {
      await collectionService.initializeCollections();
      return { status: "initialized" };
    });

    // Determine which collections to reindex
    const collectionsToReindex = collections || [
      "entities",
      "documents",
      "views",
      "projects",
      "chat_threads",
      "agents",
    ];

    const results: Record<string, any> = {};

    // Reindex each collection
    for (const collection of collectionsToReindex) {
      results[collection] = await step.run(
        `reindex-${collection}`,
        async () => {
          const db = await getDb();
          let items: any[] = [];

          // Fetch all items for workspace
          switch (collection) {
            case "entities":
              items = await db.query.entities.findMany({
                where: eq(schema.entities.workspaceId, workspaceId),
              });
              break;
            case "documents":
              items = await db.query.documents.findMany({
                where: eq(schema.documents.workspaceId, workspaceId),
              });
              break;
            case "views":
              items = await db.query.views.findMany({
                where: eq(schema.views.workspaceId, workspaceId),
              });
              break;
            case "projects":
              items = await db.query.projects.findMany({
                where: eq(schema.projects.workspaceId, workspaceId),
              });
              break;
            case "chat_threads":
              items = await db.query.chatThreads.findMany({
                where: eq((schema.chatThreads as any).workspaceId, workspaceId),
              });
              break;
            case "agents":
              items = await db.query.agents.findMany({
                where: eq((schema.agents as any).workspaceId, workspaceId),
              });
              break;
          }

          // Queue all items for indexing
          for (const item of items) {
            await indexingService.queueIndexing({
              collection,
              operation: "upsert",
              documentId: item.id,
              timestamp: Date.now(),
            });
          }

          return {
            collection,
            itemsQueued: items.length,
          };
        }
      );
    }

    // Flush queue immediately
    await step.run("flush-queue", async () => {
      return await indexingService.flushQueue();
    });

    return {
      status: "completed",
      workspaceId,
      collections: collectionsToReindex,
      results,
    };
  }
);
