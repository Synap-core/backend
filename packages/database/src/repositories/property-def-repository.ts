/**
 * Property Definition Repository
 *
 * Handles CRUD operations for property definitions.
 */

import { eq, and, isNull, inArray, or } from "drizzle-orm";
import {
  propertyDefs,
  type PropertyDef,
  type NewPropertyDef,
  type PropertyValueType,
} from "../schema/property-defs.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export interface CreatePropertyDefInput {
  slug: string;
  valueType: PropertyValueType;
  constraints?: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
  /** When set, scopes this def to a specific profile (allows reusing slug names across profiles). */
  profileId?: string;
}

export class PropertyDefRepository {
  constructor(
    private db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ) {}

  /**
   * Create a new property definition
   */
  async create(input: CreatePropertyDefInput): Promise<PropertyDef> {
    const [propertyDef] = await this.db
      .insert(propertyDefs)
      .values({
        slug: input.slug,
        valueType: input.valueType,
        constraints: input.constraints || {},
        uiHints: input.uiHints || {},
        profileId: input.profileId ?? null,
      } as NewPropertyDef)
      .returning();

    return propertyDef;
  }

  /**
   * Get property definition by slug.
   * When profileId is provided, looks up a profile-scoped def first.
   * Falls back to a global def (profileId IS NULL) if no scoped def exists.
   */
  async getBySlug(
    slug: string,
    profileId?: string
  ): Promise<PropertyDef | null> {
    if (profileId) {
      const scoped = await this.db.query.propertyDefs.findFirst({
        where: and(
          eq(propertyDefs.slug, slug),
          eq(propertyDefs.profileId, profileId)
        ),
      });
      if (scoped) return scoped;
    }
    // Fall back to global def
    const global = await this.db.query.propertyDefs.findFirst({
      where: and(eq(propertyDefs.slug, slug), isNull(propertyDefs.profileId)),
    });
    return global || null;
  }

  /**
   * Get property definition by ID
   */
  async getById(id: string): Promise<PropertyDef | null> {
    const result = await this.db.query.propertyDefs.findFirst({
      where: eq(propertyDefs.id, id),
    });

    return result || null;
  }

  /**
   * Batch-fetch property definitions by IDs.
   * Returns a Map<id, PropertyDef> for O(1) lookup.
   * Used by getEffectiveProperties() to avoid N+1 queries.
   */
  async getManyByIds(ids: string[]): Promise<Map<string, PropertyDef>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.query.propertyDefs.findMany({
      where: inArray(propertyDefs.id, ids),
    });
    return new Map(rows.map((pd) => [pd.id, pd]));
  }

  /**
   * List property definitions accessible for a given set of profile IDs.
   * Returns global defs (profileId IS NULL) + defs for the specified profiles.
   * Used by propertyDefsRouter.list() to prevent cross-workspace leaks.
   */
  async listForProfiles(profileIds: string[]): Promise<PropertyDef[]> {
    if (profileIds.length === 0) {
      // Only return global defs when no profiles are accessible
      return this.db.query.propertyDefs.findMany({
        where: isNull(propertyDefs.profileId),
        orderBy: (pd, { asc }) => [asc(pd.slug)],
      });
    }
    return this.db.query.propertyDefs.findMany({
      where: or(
        isNull(propertyDefs.profileId),
        inArray(propertyDefs.profileId, profileIds)
      ),
      orderBy: (pd, { asc }) => [asc(pd.slug)],
    });
  }

  /**
   * List all property definitions
   */
  async list(): Promise<PropertyDef[]> {
    return this.db.query.propertyDefs.findMany({
      orderBy: (propertyDefs, { asc }) => [asc(propertyDefs.slug)],
    });
  }

  /**
   * Update property definition
   */
  async update(
    id: string,
    input: Partial<CreatePropertyDefInput>
  ): Promise<PropertyDef> {
    const updateData: Partial<NewPropertyDef> = {};

    if (input.slug !== undefined) updateData.slug = input.slug;
    if (input.valueType !== undefined) updateData.valueType = input.valueType;
    if (input.constraints !== undefined)
      updateData.constraints = input.constraints;
    if (input.uiHints !== undefined) updateData.uiHints = input.uiHints;

    updateData.updatedAt = new Date();

    const [propertyDef] = await this.db
      .update(propertyDefs)
      .set(updateData)
      .where(eq(propertyDefs.id, id))
      .returning();

    if (!propertyDef) {
      throw new Error(`Property definition ${id} not found`);
    }

    return propertyDef;
  }

  /**
   * Delete property definition
   */
  async delete(id: string): Promise<void> {
    await this.db.delete(propertyDefs).where(eq(propertyDefs.id, id));
  }
}
