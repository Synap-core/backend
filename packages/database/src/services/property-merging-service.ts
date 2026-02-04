/**
 * Property Merging Service
 *
 * Merges properties from multiple profiles for views.
 * Handles property discovery, merging, and indexing status.
 */

import { ProfileResolutionService } from "./profile-resolution-service.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { entityPropertyIndex } from "../schema/entity-property-index.js";

/**
 * Merged property from multiple profiles
 */
export interface MergedProperty {
  slug: string;
  propertyDefIds: string[]; // property_defs.id values (for indexing)
  valueType: string;
  indexed: boolean; // True if ANY propertyDefId is indexed
  profiles: string[]; // Profile IDs that have this property
  // UI hints from first profile (or merged)
  uiHints?: Record<string, unknown>;
  // Constraints (most restrictive)
  constraints?: Record<string, unknown>;
}

/**
 * Service to merge properties from multiple profiles
 */
export class PropertyMergingService {
  private profileResolution: ProfileResolutionService;

  constructor(db: PostgresJsDatabase<typeof import("../schema/index.js")>) {
    this.profileResolution = new ProfileResolutionService(db);
  }

  /**
   * Get indexed property definition IDs (pre-fetch to avoid N+1)
   * Uses the "hot properties" list from PropertyIndexService
   */
  private async getIndexedPropertyDefIds(
    db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ): Promise<Set<string>> {
    // Option A: Query entity_property_index for distinct propertyDefIds
    // This tells us which properties are actually indexed
    const indexed = await db
      .selectDistinct({ propertyDefId: entityPropertyIndex.propertyDefId })
      .from(entityPropertyIndex);

    const indexedSet = new Set(indexed.map((row) => row.propertyDefId));

    return indexedSet;
  }

  /**
   * Merge properties from multiple profiles
   * Returns a map of property slug -> MergedProperty
   */
  async mergePropertiesFromProfiles(
    scopeProfileIds: string[],
    db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ): Promise<Map<string, MergedProperty>> {
    if (scopeProfileIds.length === 0) {
      return new Map();
    }

    const merged = new Map<string, MergedProperty>();

    // Pre-fetch indexed property definitions (avoid N+1)
    const indexedPropertyDefIds = await this.getIndexedPropertyDefIds(db);

    // Get effective properties from all profiles
    for (const profileId of scopeProfileIds) {
      const effectiveProps =
        await this.profileResolution.getEffectiveProperties(profileId);

      for (const prop of effectiveProps) {
        // prop.id is property_defs.id (from EffectiveProperty extends PropertyDef)
        const propertyDefId = prop.id;

        if (!merged.has(prop.slug)) {
          // First occurrence - add it
          merged.set(prop.slug, {
            slug: prop.slug,
            propertyDefIds: [propertyDefId],
            valueType: prop.valueType,
            indexed: indexedPropertyDefIds.has(propertyDefId), // Pre-fetched check
            profiles: [profileId],
            uiHints: (prop.uiHints || {}) as Record<string, unknown>,
            constraints: (prop.constraints || {}) as Record<string, unknown>,
          });
        } else {
          // Property exists in multiple profiles
          const existing = merged.get(prop.slug)!;

          // Validate type compatibility
          if (existing.valueType !== prop.valueType) {
            // Conflict! Same slug, different types
            // Log warning but continue (use first type)
            console.warn(
              `Property "${prop.slug}" has different types across profiles:`,
              `${existing.valueType} vs ${prop.valueType}. Using first type.`
            );
          }

          // Add propertyDefId to list
          existing.propertyDefIds.push(propertyDefId);

          // Update indexed if this propertyDefId is indexed
          if (indexedPropertyDefIds.has(propertyDefId)) {
            existing.indexed = true;
          }

          // Add profile to list
          existing.profiles.push(profileId);

          // Merge UI hints (prefer more specific/later profile)
          if (prop.uiHints && Object.keys(prop.uiHints).length > 0) {
            existing.uiHints = {
              ...existing.uiHints,
              ...prop.uiHints,
            };
          }

          // Merge constraints (most restrictive)
          if (prop.constraints) {
            existing.constraints = this.mergeConstraints(
              (existing.constraints || {}) as Record<string, unknown>,
              prop.constraints as Record<string, unknown>
            );
          }
        }
      }
    }

    return merged;
  }

  /**
   * Merge constraints (most restrictive wins)
   */
  private mergeConstraints(
    existing: Record<string, unknown>,
    incoming: Record<string, unknown>
  ): Record<string, unknown> {
    const merged = { ...existing };

    for (const [key, value] of Object.entries(incoming)) {
      if (key === "required") {
        // Most restrictive: if either is required, result is required
        merged[key] = existing[key] || value;
      } else if (key === "min" || key === "max") {
        // Most restrictive: min = max of both, max = min of both
        if (key === "min") {
          merged[key] = Math.max(
            (existing[key] as number) || -Infinity,
            (value as number) || -Infinity
          );
        } else {
          merged[key] = Math.min(
            (existing[key] as number) || Infinity,
            (value as number) || Infinity
          );
        }
      } else {
        // Other constraints: incoming takes precedence
        merged[key] = value;
      }
    }

    return merged;
  }

  /**
   * Resolve property slug to all propertyDefIds across profiles
   */
  async resolvePropertyDefIds(
    propertySlug: string,
    scopeProfileIds: string[],
    db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ): Promise<string[]> {
    const merged = await this.mergePropertiesFromProfiles(scopeProfileIds, db);
    const property = merged.get(propertySlug);

    if (!property) {
      return [];
    }

    return property.propertyDefIds;
  }

  /**
   * Check if property is indexed (any propertyDefId is indexed)
   */
  async isPropertyIndexed(
    propertySlug: string,
    scopeProfileIds: string[],
    db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ): Promise<boolean> {
    const merged = await this.mergePropertiesFromProfiles(scopeProfileIds, db);
    const property = merged.get(propertySlug);

    if (!property) {
      return false;
    }

    return property.indexed;
  }
}
