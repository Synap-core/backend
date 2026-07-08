/**
 * Cross-Channel Notifier Worker
 *
 * When an entity or document is updated, notifies other channels
 * that reference the same item with a system message.
 *
 * Replaces the old cross-thread-notifier worker.
 */

import type PgBoss from "pg-boss";
import {
  db,
  channelContextItems,
  messages,
  entities,
  documents,
  eq,
  and,
  ne,
  computeMessageHash,
} from "@synap/database";
import { ChannelContextObjectType, MessageRole } from "@synap/database/schema";
import { randomUUID } from "crypto";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "cross-channel-notifier" });

export async function handleCrossChannelNotify(
  job: PgBoss.Job<{
    subjectType: "entity" | "document";
    subjectId: string;
    userId: string;
    workspaceId?: string;
    originatingChannelId?: string;
  }>
): Promise<void> {
  const { subjectType, subjectId, originatingChannelId } = job.data;

  if (subjectType === "entity") {
    // Find channels with this entity linked
    const linkedRows = await db
      .select({
        channelId: channelContextItems.channelId,
        userId: channelContextItems.userId,
      })
      .from(channelContextItems)
      .where(
        originatingChannelId
          ? and(
              eq(channelContextItems.objectId, subjectId),
              eq(
                channelContextItems.objectType,
                ChannelContextObjectType.ENTITY
              ),
              ne(channelContextItems.channelId, originatingChannelId)
            )
          : and(
              eq(channelContextItems.objectId, subjectId),
              eq(
                channelContextItems.objectType,
                ChannelContextObjectType.ENTITY
              )
            )
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
      const content = `[Cross-channel update] The ${entityType} "${entityLabel}" was updated in another conversation.`;
      const id = randomUUID();
      await db.insert(messages).values({
        id,
        channelId: row.channelId,
        role: MessageRole.SYSTEM,
        content,
        userId: row.userId || "system",
        // Canonical tamper-hash: the ONE formula (see message-hash.ts).
        hash: computeMessageHash(id, content),
      });
    }

    logger.info(
      { entityId: subjectId, notified: linkedRows.length },
      "Entity cross-channel notifications sent"
    );
  } else if (subjectType === "document") {
    const linkedRows = await db
      .select({
        channelId: channelContextItems.channelId,
        userId: channelContextItems.userId,
      })
      .from(channelContextItems)
      .where(
        originatingChannelId
          ? and(
              eq(channelContextItems.objectId, subjectId),
              eq(
                channelContextItems.objectType,
                ChannelContextObjectType.DOCUMENT
              ),
              ne(channelContextItems.channelId, originatingChannelId)
            )
          : and(
              eq(channelContextItems.objectId, subjectId),
              eq(
                channelContextItems.objectType,
                ChannelContextObjectType.DOCUMENT
              )
            )
      );

    if (linkedRows.length === 0) return;

    const [doc] = await db
      .select({ title: documents.title })
      .from(documents)
      .where(eq(documents.id, subjectId))
      .limit(1);

    const docLabel = doc?.title || subjectId;

    for (const row of linkedRows) {
      const content = `[Cross-channel update] The document "${docLabel}" was updated in another conversation.`;
      const id = randomUUID();
      await db.insert(messages).values({
        id,
        channelId: row.channelId,
        role: MessageRole.SYSTEM,
        content,
        userId: row.userId || "system",
        // Canonical tamper-hash: the ONE formula (see message-hash.ts).
        hash: computeMessageHash(id, content),
      });
    }

    logger.info(
      { documentId: subjectId, notified: linkedRows.length },
      "Document cross-channel notifications sent"
    );
  }
}
