/**
 * Entity Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";
import { toSearchWorkspaceScope } from "../utils/workspace-scope.js";
import { buildEntityEmbeddingText } from "@synap/ai-embeddings";

interface Entity {
  id: string;
  title: string;
  content: string | null;
  description: string | null;
  userId: string;
  workspaceId: string | null;
  projectId: string | null;
  type: string;
  tags: string[] | null;
  status: string | null;
  /**
   * Typed property values. Already present on the Drizzle row fetched by
   * IndexingService — we now serialize it into the searchable `content` so
   * keyword search matches property values (e.g. role="VP Product").
   */
  properties: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export class EntityIndexer extends BaseIndexer<Entity> {
  collectionName = "entities";

  async toSearchDocument(entity: Entity): Promise<SearchDocument> {
    // Fold serialized property values into `content` (already a searchable
    // string field — no Typesense schema migration). Reuses the embedding
    // builder's filtering (skips _-keys, *Id keys, nulls, long/nested values),
    // so "VP Product" / "Paris" / "Q3" become keyword-matchable.
    const propsText = entity.properties
      ? buildEntityEmbeddingText({ properties: entity.properties })
      : "";
    const content =
      [entity.content, propsText].filter(Boolean).join("\n") || undefined;

    const doc: SearchDocument = {
      id: entity.id,
      title: entity.title,
      content,
      description: entity.description || undefined,
      userId: entity.userId,
      workspaceId: toSearchWorkspaceScope(entity.workspaceId),
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
