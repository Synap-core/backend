/**
 * Relation Definition Repository
 *
 * Handles CRUD for workspace-scoped relation type definitions.
 */

import { eq, and } from "drizzle-orm";
import {
  relationDefs,
  type RelationDef,
  type NewRelationDef,
} from "../schema/relation-defs.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

export interface CreateRelationDefInput {
  slug: string;
  displayName: string;
  description?: string;
  workspaceId: string;
  userId: string;
  uiHints?: Record<string, unknown>;
  isDirectional?: boolean;
}

export class RelationDefRepository {
  constructor(
    private db: PostgresJsDatabase<typeof import("../schema/index.js")>
  ) {}

  /**
   * Create or update a relation definition (upsert on slug + workspaceId)
   */
  async create(input: CreateRelationDefInput): Promise<RelationDef> {
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
      .onConflictDoUpdate({
        target: [relationDefs.slug, relationDefs.workspaceId],
        set: {
          displayName: input.displayName,
          description: input.description,
          uiHints: input.uiHints || {},
          isDirectional: input.isDirectional ?? true,
          updatedAt: new Date(),
        },
      })
      .returning();

    return def;
  }

  /**
   * List all relation definitions for a workspace
   */
  async list(workspaceId: string): Promise<RelationDef[]> {
    return this.db.query.relationDefs.findMany({
      where: eq(relationDefs.workspaceId, workspaceId),
      orderBy: (relationDefs, { asc }) => [asc(relationDefs.slug)],
    });
  }

  /**
   * Get a relation definition by slug within a workspace
   */
  async getBySlug(
    slug: string,
    workspaceId: string
  ): Promise<RelationDef | undefined> {
    return this.db.query.relationDefs.findFirst({
      where: and(
        eq(relationDefs.slug, slug),
        eq(relationDefs.workspaceId, workspaceId)
      ),
    });
  }

  /**
   * Get a relation definition by ID (within a workspace)
   */
  async getById(
    id: string,
    workspaceId: string
  ): Promise<RelationDef | undefined> {
    return this.db.query.relationDefs.findFirst({
      where: and(
        eq(relationDefs.id, id),
        eq(relationDefs.workspaceId, workspaceId)
      ),
    });
  }

  /**
   * Update an existing relation definition by ID
   */
  async update(
    id: string,
    workspaceId: string,
    input: Partial<
      Pick<
        CreateRelationDefInput,
        "displayName" | "description" | "uiHints" | "isDirectional"
      >
    >
  ): Promise<RelationDef> {
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
      .where(
        and(eq(relationDefs.id, id), eq(relationDefs.workspaceId, workspaceId))
      )
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
