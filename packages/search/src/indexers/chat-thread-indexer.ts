/**
 * Chat Thread Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";

interface ChatThread {
  id: string;
  title: string | null;
  userId: string;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export class ChatThreadIndexer extends BaseIndexer<ChatThread> {
  collectionName = "chat_threads";

  async toSearchDocument(thread: ChatThread): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: thread.id,
      title: thread.title || "Untitled Chat",
      userId: thread.userId,
      workspaceId: thread.workspaceId,
      createdAt: this.toTimestamp(thread.createdAt),
      updatedAt: this.toTimestamp(thread.updatedAt),
      summary: undefined, // TODO: Generate from messages
      messageCount: 0, // TODO: Count from messages
      lastAccessedAt: undefined,
    };

    this.validateDocument(doc);
    return doc;
  }
}
