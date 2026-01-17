/**
 * Entity Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";

interface Entity {
  id: string;
  title: string;
  content: string | null;
  description: string | null;
  userId: string;
  workspaceId: string;
  projectId: string | null;
  type: string;
  tags: string[] | null;
  status: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class EntityIndexer extends BaseIndexer<Entity> {
  collectionName = "entities";

  async toSearchDocument(entity: Entity): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: entity.id,
      title: entity.title,
      content: entity.content || undefined,
      description: entity.description || undefined,
      userId: entity.userId,
      workspaceId: entity.workspaceId,
      projectId: entity.projectId || undefined,
      entityType: entity.type,
      tags: entity.tags || undefined,
      status: entity.status || undefined,
      createdAt: this.toTimestamp(entity.createdAt),
      updatedAt: this.toTimestamp(entity.updatedAt),
      // Ranking signals (TODO: implement analytics)
      viewCount: 0,
      lastAccessedAt: undefined,
    };

    this.validateDocument(doc);
    return doc;
  }
}
