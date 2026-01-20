/**
 * View Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";

interface View {
  id: string;
  name: string;
  description: string | null;
  userId: string;
  workspaceId: string;
  type: string;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ViewIndexer extends BaseIndexer<View> {
  collectionName = "views";

  async toSearchDocument(view: View): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: view.id,
      name: view.name,
      description: view.description || undefined,
      userId: view.userId,
      workspaceId: view.workspaceId,
      viewType: view.type,
      projectId: view.projectId || undefined,
      createdAt: this.toTimestamp(view.createdAt),
      updatedAt: this.toTimestamp(view.updatedAt),
      viewCount: 0,
      lastAccessedAt: undefined,
    };

    this.validateDocument(doc);
    return doc;
  }
}
