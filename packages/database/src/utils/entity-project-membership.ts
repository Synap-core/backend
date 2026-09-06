/**
 * Entity ↔ Project Membership — the ONE write-path for `belongs_to_project`.
 *
 * Project membership is a `relations` row (entity → belongs_to_project → project).
 * The READ side of the project lens (`projectLensWhere` / `projectMemberWhere` in
 * the API's project-scope util) semi-joins exactly this relation. This module is
 * the single place that WRITES it, so the read seam is never hollow.
 *
 * Why a relation, not a column: mirrors how `workspace_id` is the entity's scope —
 * but because project membership is many-to-one/graph
 * (hierarchy, multi-project, AI-/user-editable), it is stamped as a graph edge
 * here at materialization time rather than as a column on the entity row.
 * The `target_entity_id` column on the relations table holds `projects.id`
 * (the project table primary key), NOT an entity id.
 *
 * Idempotent: relies on the partial unique index
 * `relations_belongs_to_project_unique` (migration 0137); `onConflictDoNothing()`
 * makes a pg-boss retry a no-op.
 *
 * `relations.target_entity_id` has NO foreign key to `projects` (the FK is a
 * follow-up schema decision, not made here), so this door verifies the project
 * EXISTS and is VISIBLE to `userId` before writing — otherwise a caller passing
 * a stale/foreign/invisible project id would stamp a ghost membership edge the
 * project-lens read never resolves (a silent drop reported as success upstream).
 * Reuses `userVisibleWhere` — the SAME pod-wide-owner / workspace-member
 * predicate every other visibility check in this codebase composes — rather
 * than re-deriving it, so this can never become a second, drifting mirror.
 */
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import { relations } from "../schema/relations.js";
import { createLogger } from "@synap-core/core";
import { projects } from "../schema/projects.js";

const logger = createLogger({ module: "entity-project-membership" });
import { userVisibleWhere } from "./user-visible-where.js";
import type { getDb } from "../client-pg.js";

/** Relation slug for entity→project membership. */
export const BELONGS_TO_PROJECT = "belongs_to_project";

export type LinkEntityToProjectResult =
  { linked: true } | { linked: false; reason: "project_not_found" };

/**
 * Stamp `entity --belongs_to_project--> project`. The project is a row in the
 * `projects` TABLE (NOT an entity). Safe to call repeatedly — the unique index
 * dedupes.
 *
 * Verifies the project exists and is visible to `userId` first (pod-wide
 * owner, or workspace-member via `userVisibleWhere`) — a project id that
 * doesn't resolve is refused (`{linked: false}`) rather than written as a
 * ghost edge. Callers that need to report a distinct "explicit pin missing"
 * outcome can check `reason === "project_not_found"`.
 *
 * @param db    a drizzle db (or transaction) instance
 * @param args.entityId   the produced/captured/imported entity
 * @param args.projectId  the project TABLE row id (projects.id)
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
): Promise<LinkEntityToProjectResult> {
  const [visible] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, args.projectId),
        or(
          and(isNull(projects.workspaceId), eq(projects.userId, args.userId)),
          and(
            isNotNull(projects.workspaceId),
            userVisibleWhere(projects.workspaceId, args.userId)
          )
        )
      )
    )
    .limit(1);

  if (!visible) {
    // Observable at the DOOR, once, rather than at eight call sites.
    //
    // Refusal was added here so a bad project id stops writing a ghost edge —
    // a row `projectLensWhere` can never resolve, reported to the caller as
    // stored. But of the callers, most `await` this and discard the result, so
    // the refusal became INVISIBLE: no edge, no error, no trace. That is a
    // ghost REPORT replacing a ghost EDGE, and it is worse, because absence at
    // least shows up as absence.
    //
    // Callers that can render a distinct outcome still do
    // (`package-apply-post-workspace` reports `not_linked`; the materializer
    // warns with its rung). This line is the floor under the ones that cannot:
    // an operator can always find out that a link was refused and why.
    logger.warn(
      {
        entityId: args.entityId,
        projectId: args.projectId,
        userId: args.userId,
        reason: "project_not_found",
      },
      "belongs_to_project link REFUSED — project missing or not visible to this user"
    );
    return { linked: false, reason: "project_not_found" };
  }

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

  return { linked: true };
}
