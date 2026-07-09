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
  /**
   * Live facet (role-profile) slugs attached to the entity (Kind+Facets).
   * Populated by IndexingService.fetchDocuments — an unfiltered lens (the
   * search doc is per-entity; visibility is enforced at query time elsewhere).
   */
  facetSlugs?: string[] | null;
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

    // Flatten identity handles/aliases into a searchable string[] so a lookup
    // by email/discord-handle/nickname finds the person (dedup + recall).
    const searchAliases = collectSearchAliases(entity.properties);

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
      facetSlugs:
        entity.facetSlugs && entity.facetSlugs.length > 0
          ? entity.facetSlugs
          : undefined,
      searchAliases: searchAliases.length > 0 ? searchAliases : undefined,
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

/** Flatten `email` + `discord-handle` + `aliases[]` into a deduped string[]. */
function collectSearchAliases(
  properties: Record<string, unknown> | null
): string[] {
  if (!properties) return [];
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (Array.isArray(v))
      for (const item of v)
        if (typeof item === "string" && item.trim()) out.push(item.trim());
  };
  push(properties.email);
  push(properties["discord-handle"]);
  push(properties.aliases);
  return [...new Set(out)];
}
