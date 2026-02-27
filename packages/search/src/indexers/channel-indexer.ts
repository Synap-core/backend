/**
 * Channel Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";

interface Channel {
  id: string;
  title: string | null;
  userId: string;
  workspaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ChannelIndexer extends BaseIndexer<Channel> {
  collectionName = "channels";

  async toSearchDocument(channel: Channel): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: channel.id,
      title: channel.title || "Untitled Channel",
      userId: channel.userId,
      workspaceId: channel.workspaceId ?? "",
      createdAt: this.toTimestamp(channel.createdAt),
      updatedAt: this.toTimestamp(channel.updatedAt),
      summary: undefined,
      messageCount: 0,
      lastAccessedAt: undefined,
    };

    this.validateDocument(doc);
    return doc;
  }
}
