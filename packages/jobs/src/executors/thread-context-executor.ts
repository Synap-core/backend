/**
 * Thread Context Executor
 *
 * Handles context linking events (thread_entities and thread_documents).
 * These are fast-path events (no validation needed) for read-only context tracking.
 */

import { inngest } from "../client.js";
import { getDb } from "@synap/database";
import {
  threadEntities,
  threadDocuments,
  ThreadEntityRelationshipType,
  ThreadDocumentRelationshipType,
  ThreadEntityConflictStatus,
  ThreadDocumentConflictStatus,
} from "@synap/database/schema";
import { eq, and } from "@synap/database";
import type { UnifiedEventData } from "../types/unified-events.js";

export const threadContextExecutor = inngest.createFunction(
  {
    id: "thread-context-executor",
    name: "Thread Context Executor",
    retries: 3,
  },
  [
    { event: "threadEntity.*" },
    { event: "threadDocument.*" },
  ],
  async ({ event, step }) => {
    // Parse phase directly — extractEventInfo throws on non-standard actions like "link"
    const phase = event.name.split(".")[2];
    const data = event.data as UnifiedEventData;

    // Ensure we're handling a validated event
    if (phase !== "validated") {
      console.warn(
        `[threadContextExecutor] Received non-validated event: ${event.name}`
      );
      return { success: false, reason: "Not a validated event" };
    }

    return await step.run("execute-context-link", async () => {
      const db = await getDb();

      if (event.name.startsWith("threadEntity.")) {
        // Check if link already exists
        const relationshipType =
          data.relationshipType as ThreadEntityRelationshipType;
        const existing = await db.query.threadEntities.findFirst({
          where: and(
            eq(threadEntities.threadId, data.threadId as string),
            eq(threadEntities.entityId, data.entityId as string),
            eq(threadEntities.relationshipType, relationshipType)
          ),
        });

        if (!existing) {
          // Create new link
          await db.insert(threadEntities).values({
            threadId: data.threadId as string,
            entityId: data.entityId as string,
            relationshipType,
            userId: data.userId as string,
            workspaceId: data.workspaceId as string,
            sourceMessageId:
              (data.sourceMessageId as string | undefined) || undefined,
            sourceEventId:
              (data.sourceEventId as string | undefined) || undefined,
            conflictStatus: ThreadEntityConflictStatus.NONE,
          });
        }

        return {
          status: "completed",
          threadId: data.threadId as string,
          entityId: data.entityId as string,
          message: "Entity linked to thread",
        };
      }

      if (event.name.startsWith("threadDocument.")) {
        // Check if link already exists
        const relationshipType =
          data.relationshipType as ThreadDocumentRelationshipType;
        const existing = await db.query.threadDocuments.findFirst({
          where: and(
            eq(threadDocuments.threadId, data.threadId as string),
            eq(threadDocuments.documentId, data.documentId as string),
            eq(threadDocuments.relationshipType, relationshipType)
          ),
        });

        if (!existing) {
          // Create new link
          await db.insert(threadDocuments).values({
            threadId: data.threadId as string,
            documentId: data.documentId as string,
            relationshipType,
            userId: data.userId as string,
            workspaceId: data.workspaceId as string,
            sourceMessageId:
              (data.sourceMessageId as string | undefined) || undefined,
            sourceEventId:
              (data.sourceEventId as string | undefined) || undefined,
            conflictStatus: ThreadDocumentConflictStatus.NONE,
          });
        }

        return {
          status: "completed",
          threadId: data.threadId as string,
          documentId: data.documentId as string,
          message: "Document linked to thread",
        };
      }

      throw new Error(`Unknown event type: ${event.name}`);
    });
  }
);
