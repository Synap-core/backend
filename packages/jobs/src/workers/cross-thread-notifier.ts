/**
 * Cross-Thread Notifier Worker
 *
 * When an entity or document is updated, notifies other threads
 * that reference the same item with a system message.
 *
 * Ported from Inngest executor: cross-thread-notifier.ts
 */

import type PgBoss from "pg-boss";
import {
  db,
  threadEntities,
  threadDocuments,
  conversationMessages,
  entities,
  documents,
  eq,
  and,
  ne,
} from "@synap/database";
import { randomUUID, createHash } from "crypto";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cross-thread-notifier" });

function computeMessageHash(threadId: string, content: string, role: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ threadId, content, role, timestamp: new Date().toISOString() }))
    .digest("hex");
}

export async function handleCrossThreadNotify(
  job: PgBoss.Job<{
    subjectType: "entity" | "document";
    subjectId: string;
    userId: string;
    workspaceId?: string;
    originatingThreadId?: string;
  }>
): Promise<void> {
  const { subjectType, subjectId, originatingThreadId } = job.data;

  if (subjectType === "entity") {
    // Find threads with this entity linked
    const linkedRows = await db
      .select({ threadId: threadEntities.threadId, userId: threadEntities.userId })
      .from(threadEntities)
      .where(
        originatingThreadId
          ? and(eq(threadEntities.entityId, subjectId), ne(threadEntities.threadId, originatingThreadId))
          : eq(threadEntities.entityId, subjectId)
      );

    if (linkedRows.length === 0) return;

    const [entity] = await db
      .select({ title: entities.title, type: entities.type })
      .from(entities)
      .where(eq(entities.id, subjectId))
      .limit(1);

    const entityLabel = entity?.title || subjectId;
    const entityType = entity?.type || "entity";

    for (const row of linkedRows) {
      const content = `[Cross-thread update] The ${entityType} "${entityLabel}" was updated in another conversation.`;
      await db.insert(conversationMessages).values({
        id: randomUUID(),
        threadId: row.threadId,
        role: "system",
        content,
        userId: row.userId || "system",
        hash: computeMessageHash(row.threadId, content, "system"),
      });
    }

    logger.info({ entityId: subjectId, notified: linkedRows.length }, "Entity cross-thread notifications sent");
  } else if (subjectType === "document") {
    const linkedRows = await db
      .select({ threadId: threadDocuments.threadId, userId: threadDocuments.userId })
      .from(threadDocuments)
      .where(
        originatingThreadId
          ? and(eq(threadDocuments.documentId, subjectId), ne(threadDocuments.threadId, originatingThreadId))
          : eq(threadDocuments.documentId, subjectId)
      );

    if (linkedRows.length === 0) return;

    const [doc] = await db
      .select({ title: documents.title })
      .from(documents)
      .where(eq(documents.id, subjectId))
      .limit(1);

    const docLabel = doc?.title || subjectId;

    for (const row of linkedRows) {
      const content = `[Cross-thread update] The document "${docLabel}" was updated in another conversation.`;
      await db.insert(conversationMessages).values({
        id: randomUUID(),
        threadId: row.threadId,
        role: "system",
        content,
        userId: row.userId || "system",
        hash: computeMessageHash(row.threadId, content, "system"),
      });
    }

    logger.info({ documentId: subjectId, notified: linkedRows.length }, "Document cross-thread notifications sent");
  }
}
