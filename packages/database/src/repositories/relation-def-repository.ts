/**
 * Relation Definition Repository
 *
 * Handles CRUD for workspace-scoped relation type definitions.
 */

import { eq, and, or, isNull, sql } from "drizzle-orm";
import {
  relationDefs,
  type RelationDef,
  type NewRelationDef,
} from "../schema/relation-defs.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../schema/index.js";

export interface CreateRelationDefInput {
  slug: string;
  displayName: string;
  description?: string;
  /** Nullable for pod-wide relation definitions */
  workspaceId: string | null;
  userId: string;
  uiHints?: Record<string, unknown>;
  isDirectional?: boolean;
}

export class RelationDefRepository {
  constructor(private db: PostgresJsDatabase<typeof schema>) {}

  /**
   * Create a relation definition (find-or-create).
   * Pod-wide defs (workspaceId = null) are unique by slug alone.
   * Workspace defs are unique by (slug, workspaceId).
   */
  async create(input: CreateRelationDefInput): Promise<RelationDef> {
    // Find existing
    const existing = input.workspaceId
      ? await this.db.query.relationDefs.findFirst({
          where: and(
            eq(relationDefs.slug, input.slug),
            eq(relationDefs.workspaceId, input.workspaceId)
          ),
        })
      : await this.db.query.relationDefs.findFirst({
          where: and(
            eq(relationDefs.slug, input.slug),
            sql`${relationDefs.workspaceId} IS NULL`
          ),
        });

    if (existing) {
      // Update the existing def
      const [updated] = await this.db
        .update(relationDefs)
        .set({
          displayName: input.displayName,
          description: input.description,
          uiHints: input.uiHints || {},
          isDirectional: input.isDirectional ?? true,
          updatedAt: new Date(),
        })
        .where(eq(relationDefs.id, existing.id))
        .returning();
      return updated;
    }

    // Create new
    const [def] = await this.db
      .insert(relationDefs)
      .values({
        slug: input.slug,
        displayName: input.displayName,
        description: input.description,
        workspaceId: input.workspaceId,
        userId: input.userId,
        uiHints: input.uiHints || {},
        isDirectional: input.isDirectional ?? true,
      } as NewRelationDef)
      .returning();

    return def;
  }

  /**
   * List relation definitions visible from a workspace.
   * Includes both workspace-scoped defs AND pod-wide defs (workspace_id IS NULL).
   */
  async list(workspaceId: string): Promise<RelationDef[]> {
    return this.db.query.relationDefs.findMany({
      where: (relationDefs, { or, isNull, eq }) =>
        or(
          eq(relationDefs.workspaceId, workspaceId),
          isNull(relationDefs.workspaceId)
        ),
      orderBy: (relationDefs, { asc }) => [asc(relationDefs.slug)],
    });
  }

  /**
   * Get a relation definition by slug. Searches workspace-scoped first,
   * then falls back to pod-wide.
   */
  async getBySlug(
    slug: string,
    workspaceId: string
  ): Promise<RelationDef | undefined> {
    // Prefer workspace-scoped
    const wsDef = await this.db.query.relationDefs.findFirst({
      where: and(
        eq(relationDefs.slug, slug),
        eq(relationDefs.workspaceId, workspaceId)
      ),
    });
    if (wsDef) return wsDef;
    // Fall back to pod-wide
    return this.db.query.relationDefs.findFirst({
      where: and(
        eq(relationDefs.slug, slug),
        sql`${relationDefs.workspaceId} IS NULL`
      ),
    });
  }

  /**
   * Get a relation definition by ID. Works for both workspace-scoped and pod-wide.
   */
  async getById(
    id: string,
    workspaceId?: string
  ): Promise<RelationDef | undefined> {
    const where = workspaceId
      ? and(
          eq(relationDefs.id, id),
          or(
            eq(relationDefs.workspaceId, workspaceId),
            isNull(relationDefs.workspaceId)
          )
        )
      : eq(relationDefs.id, id);
    return this.db.query.relationDefs.findFirst({ where });
  }

  /**
   * Update an existing relation definition by ID
   */
  async update(
    id: string,
    workspaceId: string | null,
    input: Partial<
      Pick<
        CreateRelationDefInput,
        "displayName" | "description" | "uiHints" | "isDirectional"
      >
    >
  ): Promise<RelationDef> {
    const where = workspaceId
      ? and(eq(relationDefs.id, id), eq(relationDefs.workspaceId, workspaceId))
      : eq(relationDefs.id, id);
    const [updated] = await this.db
      .update(relationDefs)
      .set({
        ...(input.displayName !== undefined && {
          displayName: input.displayName,
        }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.uiHints !== undefined && { uiHints: input.uiHints }),
        ...(input.isDirectional !== undefined && {
          isDirectional: input.isDirectional,
        }),
        updatedAt: new Date(),
      })
      .where(where)
      .returning();

    if (!updated) {
      throw new Error(`Relation definition not found: ${id}`);
    }

    return updated;
  }

  /**
   * Delete a relation definition
   */
  async delete(id: string): Promise<void> {
    const result = await this.db
      .delete(relationDefs)
      .where(eq(relationDefs.id, id))
      .returning({ id: relationDefs.id });

    if (result.length === 0) {
      throw new Error(`Relation definition not found: ${id}`);
    }
  }
}
