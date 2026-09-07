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
  id?: string;
  slug: string;
  displayName: string;
  description?: string;
  /** Nullable for pod-wide relation definitions */
  workspaceId: string | null;
  userId: string;
  uiHints?: Record<string, unknown>;
  isDirectional?: boolean;
}

/**
 * JS SSOT for relation-def PRECEDENCE under a workspace lens: a workspace-scoped
 * row always wins over the pod-wide (workspace_id IS NULL) base row for the same
 * slug. `getBySlug` expresses the same rule in SQL (two ordered probes); every
 * caller that resolves precedence over an already-loaded row set must use these
 * so a third, divergent copy can never appear.
 *
 * Deliberately pure and array-based: a rule that lives only inside a SQL
 * predicate is invisible to every mocked-query test, and therefore untestable.
 */
export function pickDefForWorkspace<
  T extends { slug: string; workspaceId: string | null },
>(defs: T[], slug: string, workspaceId: string | null): T | undefined {
  let held: T | undefined;
  for (const def of defs) {
    if (def.slug !== slug) continue;
    // Only rows in the lens or pod-wide rows are candidates.
    if (def.workspaceId !== null && def.workspaceId !== workspaceId) continue;
    if (!held || (held.workspaceId === null && def.workspaceId !== null)) {
      held = def;
    }
  }
  return held;
}

/**
 * Collapse rows sharing a slug under an ACTIVE workspace lens, keeping the
 * workspace row over the pod-wide base row. Input order is preserved.
 *
 * Only ever apply this in-lens: with no workspace the row set spans several
 * workspaces, where two rows sharing a slug are genuinely distinct.
 */
export function dedupeDefsForLens<
  T extends { slug: string; workspaceId: string | null },
>(defs: T[]): T[] {
  const bySlug = new Map<string, T>();
  for (const def of defs) {
    const held = bySlug.get(def.slug);
    if (!held || (held.workspaceId === null && def.workspaceId !== null)) {
      bySlug.set(def.slug, def);
    }
  }
  return [...bySlug.values()];
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
        ...(input.id ? { id: input.id } : {}),
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
  async list(workspaceId?: string | null): Promise<RelationDef[]> {
    // Workspace is a LENS: present → this workspace's defs + pod-wide globals;
    // absent (null/undefined) → globals only. Never bind a falsy workspaceId
    // into the uuid column (that throws `invalid input syntax for type uuid`).
    return this.db.query.relationDefs.findMany({
      where: (relationDefs, { or, isNull, eq }) =>
        workspaceId
          ? or(
              eq(relationDefs.workspaceId, workspaceId),
              isNull(relationDefs.workspaceId)
            )
          : isNull(relationDefs.workspaceId),
      orderBy: (relationDefs, { asc }) => [asc(relationDefs.slug)],
    });
  }

  /**
   * Get a relation definition by slug. With a workspace lens, prefers the
   * workspace-scoped def then falls back to pod-wide; without one, pod-wide only.
   */
  async getBySlug(
    slug: string,
    workspaceId?: string | null
  ): Promise<RelationDef | undefined> {
    // Prefer workspace-scoped only when a workspace lens is active.
    if (workspaceId) {
      const wsDef = await this.db.query.relationDefs.findFirst({
        where: and(
          eq(relationDefs.slug, slug),
          eq(relationDefs.workspaceId, workspaceId)
        ),
      });
      if (wsDef) return wsDef;
    }
    // Pod-wide (global) fallback.
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
   * Delete a relation definition.
   *
   * WORKSPACE FLOOR: pass the caller's workspace and a workspace-scoped caller
   * can only delete a def that LIVES in that workspace — never a pod-wide
   * (workspace_id IS NULL) base def that every workspace on the pod resolves
   * through, and never another workspace's def. Pod-wide defs ARE visible under
   * a workspace lens (`includeGlobalsInLens: true`), so visibility alone must
   * not confer deletion.
   *
   * The check is in JS, not folded into the DELETE's WHERE, so it is provable
   * without a live Postgres: a guard that exists only inside a SQL predicate is
   * invisible to every mocked-query test and therefore untested.
   *
   * Omitting `workspaceId` keeps the unscoped behaviour for pod-level callers.
   * Today the only caller is the workspace-scoped tRPC router, which passes one.
   */
  async delete(id: string, workspaceId?: string | null): Promise<void> {
    if (workspaceId) {
      const existing = await this.db.query.relationDefs.findFirst({
        where: eq(relationDefs.id, id),
      });
      // Not found and not-yours are the SAME answer on purpose: a workspace
      // caller must not be able to probe another workspace's ids.
      if (!existing || existing.workspaceId !== workspaceId) {
        throw new Error(`Relation definition not found: ${id}`);
      }
    }

    const result = await this.db
      .delete(relationDefs)
      .where(eq(relationDefs.id, id))
      .returning({ id: relationDefs.id });

    if (result.length === 0) {
      throw new Error(`Relation definition not found: ${id}`);
    }
  }
}
