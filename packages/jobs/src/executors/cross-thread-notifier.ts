/**
 * Cross-Thread Notifier
 *
 * When an entity or document is updated in one thread, other threads that
 * reference the same item receive a system notification message.
 *
 * Listens to: entity.update.completed, document.update.completed
 *
 * Design: Uses two separate Inngest functions (entity and document) to keep
 * triggers clean. Each function uses a trailing wildcard (`entity.*`,
 * `document.*`) and filters internally to only act on `update.completed`.
 */

import { inngest } from "../client.js";
import { db, threadEntities, threadDocuments, conversationMessages, entities, documents, eq, and, ne } from "@synap/database";
import { extractEventInfo, type UnifiedEventData } from "../types/unified-events.js";
import { randomUUID, createHash } from "crypto";

function computeMessageHash(threadId: string, content: string, role: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ threadId, content, role, timestamp: new Date().toISOString() }))
    .digest("hex");
}

/**
 * Notify threads that reference an updated entity.
 */
export const crossThreadEntityNotifier = inngest.createFunction(
  {
    id: "cross-thread-entity-notifier",
    name: "Cross-Thread Entity Notifier",
    retries: 2,
  },
  { event: "entity.*" },
  async ({ event, step }) => {
    const eventInfo = extractEventInfo(event.name);
    const { action, phase } = eventInfo;

    // Only act on entity.update.completed
    if (action !== "update" || phase !== "completed") {
      return { skipped: true, reason: `Not an update.completed event: ${event.name}` };
    }

    const data = event.data as UnifiedEventData;
    const entityId = (data.id || data.entityId) as string | undefined;

    if (!entityId) {
      return { skipped: true, reason: "No entityId in event data" };
    }

    return await step.run("notify-linked-threads", async () => {
      // Find threads that have this entity linked (excluding the originating thread if known)
      const originatingThreadId = (data.threadId || data.originatingThreadId) as string | undefined;

      const linkedRows = await db
        .select({ threadId: threadEntities.threadId, userId: threadEntities.userId })
        .from(threadEntities)
        .where(
          originatingThreadId
            ? and(eq(threadEntities.entityId, entityId), ne(threadEntities.threadId, originatingThreadId))
            : eq(threadEntities.entityId, entityId)
        );

      if (linkedRows.length === 0) {
        return { notified: 0, entityId };
      }

      // Fetch entity name for the message
      const [entity] = await db
        .select({ title: entities.title, type: entities.type })
        .from(entities)
        .where(eq(entities.id, entityId))
        .limit(1);

      const entityLabel = entity?.title || entityId;
      const entityType = entity?.type || "entity";

      // Insert a system notification message in each linked thread
      const notifications = linkedRows.map((row) => {
        const content = `📝 The ${entityType} "${entityLabel}" was updated in another conversation. You may want to review the latest changes.`;
        return {
          id: randomUUID(),
          threadId: row.threadId,
          role: "system" as const,
          content,
          userId: row.userId || "system",
          hash: computeMessageHash(row.threadId, content, "system"),
          metadata: {
            type: "cross_thread_notification",
            entityId,
            entityLabel,
            entityType,
            updatedAt: new Date().toISOString(),
          },
        };
      });

      for (const msg of notifications) {
        await db.insert(conversationMessages).values(msg);
      }

      return { notified: notifications.length, entityId, entityLabel };
    });
  }
);

/**
 * Notify threads that reference an updated document.
 */
export const crossThreadDocumentNotifier = inngest.createFunction(
  {
    id: "cross-thread-document-notifier",
    name: "Cross-Thread Document Notifier",
    retries: 2,
  },
  { event: "document.*" },
  async ({ event, step }) => {
    const eventInfo = extractEventInfo(event.name);
    const { action, phase } = eventInfo;

    // Only act on document.update.completed
    if (action !== "update" || phase !== "completed") {
      return { skipped: true, reason: `Not an update.completed event: ${event.name}` };
    }

    const data = event.data as UnifiedEventData;
    const documentId = (data.id || data.documentId) as string | undefined;

    if (!documentId) {
      return { skipped: true, reason: "No documentId in event data" };
    }

    return await step.run("notify-linked-threads", async () => {
      const originatingThreadId = (data.threadId || data.originatingThreadId) as string | undefined;

      const linkedRows = await db
        .select({ threadId: threadDocuments.threadId, userId: threadDocuments.userId })
        .from(threadDocuments)
        .where(
          originatingThreadId
            ? and(eq(threadDocuments.documentId, documentId), ne(threadDocuments.threadId, originatingThreadId))
            : eq(threadDocuments.documentId, documentId)
        );

      if (linkedRows.length === 0) {
        return { notified: 0, documentId };
      }

      // Fetch document title for the message
      const [doc] = await db
        .select({ title: documents.title })
        .from(documents)
        .where(eq(documents.id, documentId))
        .limit(1);

      const docLabel = doc?.title || documentId;

      const notifications = linkedRows.map((row) => {
        const content = `📄 The document "${docLabel}" was updated in another conversation. You may want to review the latest changes.`;
        return {
          id: randomUUID(),
          threadId: row.threadId,
          role: "system" as const,
          content,
          userId: row.userId || "system",
          hash: computeMessageHash(row.threadId, content, "system"),
          metadata: {
            type: "cross_thread_notification",
            documentId,
            documentLabel: docLabel,
            updatedAt: new Date().toISOString(),
          },
        };
      });

      for (const msg of notifications) {
        await db.insert(conversationMessages).values(msg);
      }

      return { notified: notifications.length, documentId, docLabel };
    });
  }
);
