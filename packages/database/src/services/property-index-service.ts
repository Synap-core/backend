/**
 * Property Index Service
 *
 * Manages the entity_property_index table for fast queries.
 * This is a projection/index, NOT the source of truth.
 */

import { EntityPropertyIndexRepository } from "../repositories/entity-property-index-repository.js";
import { ProfileResolutionService } from "./profile-resolution-service.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export class PropertyIndexService {
  private indexRepo: EntityPropertyIndexRepository;
  private profileResolution: ProfileResolutionService;

  constructor(db: PostgresJsDatabase<typeof import("../schema/index.js")>) {
    this.indexRepo = new EntityPropertyIndexRepository(db);
    this.profileResolution = new ProfileResolutionService(db);
  }

  /**
   * Index all properties for an entity
   * Only indexes properties that should be indexed (hot properties)
   */
  async indexEntityProperties(
    entityId: string,
    properties: Record<string, unknown>,
    profileId: string
  ): Promise<void> {
    // Get effective properties to know which ones to index
    const effectiveProperties =
      await this.profileResolution.getEffectiveProperties(profileId);

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
   * Reindex an entity (useful for backfills)
   */
  async reindexEntity(
    entityId: string,
    properties: Record<string, unknown>,
    profileId: string
  ): Promise<void> {
    // Remove existing index
    await this.removeEntityIndex(entityId);
    // Reindex
    await this.indexEntityProperties(entityId, properties, profileId);
  }
}
