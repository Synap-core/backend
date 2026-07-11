/**
 * Message Indexer
 *
 * `workspaceId` is not a column on `messages`; it is JOINED from
 * `channels.workspaceId` by IndexingService before conversion (see
 * fetchDocuments / fullReindex). Ephemeral + soft-deleted messages are excluded
 * at the fetch stage, so they never reach this converter.
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";
import { toSearchWorkspaceScope } from "../utils/workspace-scope.js";

interface Message {
  id: string;
  channelId: string;
  /** Joined from channels.workspaceId at index time. */
  workspaceId: string | null;
  userId: string;
  content: string;
  role: string | null;
  /** messages.timestamp */
  timestamp: Date;
  /** messages.editedAt */
  editedAt: Date | null;
}

export class MessageIndexer extends BaseIndexer<Message> {
  collectionName = "messages";

  async toSearchDocument(message: Message): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: message.id,
      channelId: message.channelId,
      workspaceId: toSearchWorkspaceScope(message.workspaceId),
      userId: message.userId,
      content: message.content,
      role: message.role || undefined,
      createdAt: this.toTimestamp(message.timestamp),
      updatedAt: this.toTimestamp(message.editedAt ?? message.timestamp),
    };

    this.validateDocument(doc);
    return doc;
  }
}
