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
  /**
   * When set, scopes this def to a specific profile (allows reusing slug
   * names across profiles — e.g. `status` on both `task` and `campaign`).
   */
  profileId?: string;
  /**
   * When set, scopes this def to a specific workspace on top of the profile
   * scope — the def becomes an "overlay" that only renders when the current
   * workspace context matches. See schema/property-defs.ts for the full
   * scope matrix. Leave undefined to create a "base" def visible to every
   * workspace that uses the profile.
   */
  workspaceId?: string | null;
}

export class PropertyDefRepository {
  constructor(
    private db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ) {}

  /**
   * Create a new property definition.
   *
   * Scope resolution:
   *   • profileId + workspaceId both NULL → global/system def
   *   • profileId SET,    workspaceId NULL → "base" def on that profile
   *                                          (every workspace sees it)
   *   • profileId SET,    workspaceId SET  → "overlay" def — only the owning
   *                                          workspace renders it
   *   • profileId NULL,   workspaceId SET  → invalid; we normalize to NULL
   *
   * Slug uniqueness is enforced by migration 0065's partial unique indexes.
   */
  async create(input: CreatePropertyDefInput): Promise<PropertyDef> {
    // Overlays without a profile make no sense — the scope would be ambiguous.
    const workspaceId =
      input.profileId && input.workspaceId ? input.workspaceId : null;

    const [propertyDef] = await this.db
      .insert(propertyDefs)
      .values({
        slug: input.slug,
        valueType: input.valueType,
        constraints: input.constraints || {},
        uiHints: input.uiHints || {},
        profileId: input.profileId ?? null,
        workspaceId,
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
   *
   * When `workspaceId` is provided, filters out overlay defs owned by a
   * different workspace — callers normally render through a workspace lens
   * and want this filter applied at SQL level (avoids fetching then dropping).
   * Pass undefined / omit to bypass the filter (admin / unfiltered queries).
   */
  async getManyByIds(
    ids: string[],
    workspaceId?: string | null
  ): Promise<Map<string, PropertyDef>> {
    if (ids.length === 0) return new Map();
    const baseWhere = inArray(propertyDefs.id, ids);
    const where =
      workspaceId === undefined
        ? baseWhere
        : and(
            baseWhere,
            or(
              isNull(propertyDefs.workspaceId),
              // workspaceId null on the ctx side means "only base defs" —
              // overlays need an actual workspace context to render.
              workspaceId
                ? eq(propertyDefs.workspaceId, workspaceId)
                : isNull(propertyDefs.workspaceId)
            )!
          );
    const rows = await this.db.query.propertyDefs.findMany({ where });
    return new Map(rows.map((pd) => [pd.id, pd]));
  }

  /**
   * List property definitions accessible for a given set of profile IDs.
   * Returns global defs (profileId IS NULL) + defs for the specified profiles.
   * Used by propertyDefsRouter.list() to prevent cross-workspace leaks.
   *
   * When `workspaceId` is provided, overlay defs owned by another workspace
   * are filtered out. This is the standard rendering path — almost every
   * caller should pass a workspaceId. Omit only for admin/debug listings.
   */
  async listForProfiles(
    profileIds: string[],
    workspaceId?: string | null
  ): Promise<PropertyDef[]> {
    const workspaceFilter =
      workspaceId === undefined
        ? undefined
        : or(
            isNull(propertyDefs.workspaceId),
            workspaceId
              ? eq(propertyDefs.workspaceId, workspaceId)
              : isNull(propertyDefs.workspaceId)
          );

    if (profileIds.length === 0) {
      return this.db.query.propertyDefs.findMany({
        where: workspaceFilter
          ? and(isNull(propertyDefs.profileId), workspaceFilter)
          : isNull(propertyDefs.profileId),
        orderBy: (pd, { asc }) => [asc(pd.slug)],
      });
    }
    const profileFilter = or(
      isNull(propertyDefs.profileId),
      inArray(propertyDefs.profileId, profileIds)
    );
    return this.db.query.propertyDefs.findMany({
      where: workspaceFilter
        ? and(profileFilter, workspaceFilter)
        : profileFilter,
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
