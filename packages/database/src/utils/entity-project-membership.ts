/**
 * Entity ↔ Project Membership — the ONE write-path for `belongs_to_project`.
 *
 * Project membership is a `relations` row (entity → belongs_to_project → project).
 * The READ side of the project lens (`projectLensWhere` / `projectMemberWhere` in
 * the API's project-scope util) semi-joins exactly this relation. This module is
 * the single place that WRITES it, so the read seam is never hollow.
 *
 * Why a relation, not a column: mirrors how `workspace_id` is the entity's scope —
 * but because a project is itself an entity and membership is many-to-one/graph
 * (hierarchy, multi-project, AI-/user-editable), it is stamped as a graph edge
 * here at materialization time rather than as a column on the entity row.
 *
 * Idempotent: relies on the partial unique index
 * `relations_belongs_to_project_unique` (migration 0137); `onConflictDoNothing()`
 * makes a pg-boss retry a no-op.
 */
import { relations } from "../schema/relations.js";
import type { getDb } from "../client-pg.js";

/** Relation slug for entity→project membership. */
export const BELONGS_TO_PROJECT = "belongs_to_project";

/**
 * Stamp `entity --belongs_to_project--> project`. Safe to call repeatedly and
 * with the same (entity, project) pair — the unique index dedupes.
 *
 * @param db    a drizzle db (or transaction) instance
 * @param args.entityId   the produced/captured/imported entity
 * @param args.projectId  the project ENTITY id (profileSlug='project')
 * @param args.userId     owner stamped on the relation row (NOT NULL)
 * @param args.workspaceId the materializing workspace lens, or null for pod-wide
 */
export async function linkEntityToProject(
  db: Awaited<ReturnType<typeof getDb>>,
  args: {
    entityId: string;
    projectId: string;
    userId: string;
    workspaceId?: string | null;
  }
): Promise<void> {
  await db
    .insert(relations)
    .values({
      userId: args.userId,
      workspaceId: args.workspaceId ?? null,
      sourceEntityId: args.entityId,
      targetEntityId: args.projectId,
      type: BELONGS_TO_PROJECT,
    })
    .onConflictDoNothing();
}
