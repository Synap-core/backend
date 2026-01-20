/**
 * Inbox Storage Handler
 *
 * Listens to: inbox.item.received
 * Action: Write inbox item to database
 */

import { db, inboxItems } from "@synap/database";
import type { InboxItemReceivedEvent } from "@synap/events";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "inbox-storage-handler" });

/**
 * Handle inbox item received event
 * Writes the inbox item to the database
 */
export async function handleInboxItemReceived(
  event: InboxItemReceivedEvent & {
    id: string;
    userId: string;
    timestamp: Date;
  }
) {
  logger.info(
    {
      itemId: event.subjectId,
      provider: event.data.provider,
    },
    "Storing inbox item"
  );

  try {
    await db.insert(inboxItems).values({
      id: event.subjectId,
      userId: event.userId,
      provider: event.data.provider,
      account: event.data.account, // ✅ Required field
      externalId: event.data.externalId,
      type: event.data.type,
      title: event.data.title,
      preview: event.data.preview,
      timestamp: event.data.timestamp,
      deepLink: event.data.deepLink,
      data: event.data.rawData,
      workspaceId: event.data.workspaceId,
      status: "unread",
    });

    logger.info({ itemId: event.subjectId }, "Inbox item stored successfully");
  } catch (error) {
    logger.error(
      {
        err: error,
        itemId: event.subjectId,
      },
      "Failed to store inbox item"
    );
    throw error;
  }
}
