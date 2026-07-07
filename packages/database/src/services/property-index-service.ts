/**
 * Property Index Service
 *
 * Manages the entity_property_index table for fast queries.
 * This is a projection/index, NOT the source of truth.
 */

import { EntityPropertyIndexRepository } from "../repositories/entity-property-index-repository.js";
import { ProfileResolutionService } from "./profile-resolution-service.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export class PropertyIndexService {
  private indexRepo: EntityPropertyIndexRepository;
  private profileResolution: ProfileResolutionService;

  constructor(db: PostgresJsDatabase<typeof schema>) {
    this.indexRepo = new EntityPropertyIndexRepository(db);
    this.profileResolution = new ProfileResolutionService(db);
  }

  /**
   * Index all properties for an entity (hot properties only).
   *
   * The index is a projection used for fast querying. When `workspaceId` is
   * supplied, it covers both "base" props and that workspace's overlay props.
   * Entity reads filter the same way, so the index stays coherent.
   */
  async indexEntityProperties(
    entityId: string,
    properties: Record<string, unknown>,
    profileId: string,
    workspaceId?: string | null
  ): Promise<void> {
    // Get effective properties to know which ones to index
    const effectiveProperties =
      await this.profileResolution.getEffectiveProperties(
        profileId,
        workspaceId
      );

    // Index hot properties (commonly filtered/sorted properties)
    // These properties are frequently used in views and benefit from indexing
    const hotPropertySlugs = [
      "title", // Text search
      "status", // Enum filtering (todo, in-progress, done)
      "priority", // Enum filtering (low, medium, high, urgent)
      "dueDate", // Date filtering/sorting
      "startTime", // Date filtering/sorting
      "endTime", // Date filtering/sorting
      "assignee", // Entity ID filtering
      "email", // Identity dedup — scalar → value_text, (property_def_id, value_text) index
      "discord-handle", // Identity dedup — scalar → value_text
      // NOTE: `aliases` is intentionally NOT indexed here. It's an array; rather
      // than invent a multi-value index scheme, dedup gates match it via JSONB
      // containment on the source `entities.properties->'aliases'` at query time
      // (see entity-resolution.ts). EntityPropertyIndexRepository.index() would
      // route an array to `value_jsonb`, which the (property_def_id, value_text)
      // lookup can't hit anyway.
    ];

    for (const prop of effectiveProperties) {
      // Only index hot properties for now
      if (!hotPropertySlugs.includes(prop.slug)) continue;

      const value = properties[prop.slug];
      if (value === undefined || value === null) continue;

      try {
        await this.indexRepo.index(entityId, prop.id, value, prop.valueType);
      } catch (error) {
        // Log but don't fail - indexing is optional
        console.warn(
          `Failed to index property ${prop.slug} for entity ${entityId}:`,
          error
        );
      }
    }
  }

  /**
   * Remove all indexed properties for an entity
   */
  async removeEntityIndex(entityId: string): Promise<void> {
    await this.indexRepo.removeEntity(entityId);
  }

  /**
   * Reindex an entity (useful for backfills / property updates).
   *
   * `workspaceId` should be the lens through which the write is happening
   * — i.e. the calling workspace — so overlay props are indexed alongside
   * base props for that workspace.
   */
  async reindexEntity(
    entityId: string,
    properties: Record<string, unknown>,
    profileId: string,
    workspaceId?: string | null
  ): Promise<void> {
    // Remove existing index
    await this.removeEntityIndex(entityId);
    // Reindex through the workspace lens
    await this.indexEntityProperties(
      entityId,
      properties,
      profileId,
      workspaceId
    );
  }
}
