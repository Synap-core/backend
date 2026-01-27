/**
 * Thread Context Executor
 *
 * Handles context linking events (thread_entities and thread_documents).
 * These are fast-path events (no validation needed) for read-only context tracking.
 */

import { inngest } from "../client.js";
import { getDb } from "@synap/database";
import { threadEntities, threadDocuments } from "@synap/database/schema";
import { eq, and } from "@synap/database";

export const threadContextExecutor = inngest.createFunction(
  {
    id: "thread-context-executor",
    name: "Thread Context Executor",
    retries: 3,
  },
  [
    { event: "thread_entities.link.validated" },
    { event: "thread_documents.link.validated" },
  ],
  async ({ event, step }) => {
    const eventType = event.name;
    const data = event.data;

    return await step.run("execute-context-link", async () => {
      const db = await getDb();

      if (eventType === "thread_entities.link.validated") {
        // Check if link already exists
        const existing = await db.query.threadEntities.findFirst({
          where: and(
            eq(threadEntities.threadId, data.threadId),
            eq(threadEntities.entityId, data.entityId),
            eq(threadEntities.relationshipType, data.relationshipType)
          ),
        });

        if (!existing) {
          // Create new link
          await db.insert(threadEntities).values({
            threadId: data.threadId,
            entityId: data.entityId,
            relationshipType: data.relationshipType,
            userId: data.userId,
            workspaceId: data.workspaceId,
            sourceMessageId: data.sourceMessageId || undefined,
            sourceEventId: data.sourceEventId || undefined,
            conflictStatus: "none",
          });
        }

        return {
          status: "completed",
          threadId: data.threadId,
          entityId: data.entityId,
          message: "Entity linked to thread",
        };
      }

      if (eventType === "thread_documents.link.validated") {
        // Check if link already exists
        const existing = await db.query.threadDocuments.findFirst({
          where: and(
            eq(threadDocuments.threadId, data.threadId),
            eq(threadDocuments.documentId, data.documentId),
            eq(threadDocuments.relationshipType, data.relationshipType)
          ),
        });

        if (!existing) {
          // Create new link
          await db.insert(threadDocuments).values({
            threadId: data.threadId,
            documentId: data.documentId,
            relationshipType: data.relationshipType,
            userId: data.userId,
            workspaceId: data.workspaceId,
            sourceMessageId: data.sourceMessageId || undefined,
            sourceEventId: data.sourceEventId || undefined,
            conflictStatus: "none",
          });
        }

        return {
          status: "completed",
          threadId: data.threadId,
          documentId: data.documentId,
          message: "Document linked to thread",
        };
      }

      throw new Error(`Unknown event type: ${eventType}`);
    });
  }
);
