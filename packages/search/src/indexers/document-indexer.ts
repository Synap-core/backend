/**
 * Document Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";

interface Document {
  id: string;
  title: string;
  content: string | null;
  userId: string;
  workspaceId: string;
  type: string | null;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class DocumentIndexer extends BaseIndexer<Document> {
  collectionName = "documents";

  async toSearchDocument(document: Document): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: document.id,
      title: document.title,
      content: document.content || undefined,
      userId: document.userId,
      workspaceId: document.workspaceId,
      documentType: document.type || undefined,
      projectId: document.projectId || undefined,
      createdAt: this.toTimestamp(document.createdAt),
      updatedAt: this.toTimestamp(document.updatedAt),
      viewCount: 0,
      lastAccessedAt: undefined,
    };

    this.validateDocument(doc);
    return doc;
  }
}
