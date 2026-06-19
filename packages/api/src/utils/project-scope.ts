/**
 * `project-scope` — the PROJECT axis of the unified access seam.
 *
 * The deliberate mirror of `user-visible-where.ts` (the WORKSPACE axis). Where
 * workspace is a lens keyed on `workspace_id`, project is a cross-cutting data
 * scope keyed on the entity graph: an entity is "in" a project iff it IS that
 * project entity, or it has a `belongs_to_project` relation pointing at it
 * (source = member entity, target = project entity). Project membership lives in
 * the `project_members` table (keyed on the project ENTITY id after the 0134
 * repoint), so it is a fast indexed access-join — exactly like
 * `workspace_members` for the workspace axis.
 *
 * Two roles, both as composable Drizzle predicates over an ENTITY-ID column:
 *   - `projectMemberWhere` — the FLOOR's third access source: rows the user may
 *      see because they are a member of the owning project. ORed into the access
 *      floor alongside the workspace union + pod-personal branch.
 *   - `projectLensWhere`   — the optional NARROWING lens to a single project.
 *      PURE: it must be ANDed with the access floor by the caller
 *      (`accessScopeWhere`); on its own it only narrows and can never widen.
 *
 * Both operate on whichever entity-id column the table exposes (e.g.
 * `entities.id`). Tables without an entity-graph identity (LENS-CONFIG tables
 * like views/property_defs) do NOT use the project axis — see the per-table
 * axis map in team/platform/project-centric-scope.mdx.
 */

import { and, eq, inArray, isNull, isNotNull, or } from "@synap/database";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@synap/database";
import { projectMembers, relations } from "@synap/database/schema";
import { userVisibleWhere, workspaceLensWhere } from "./user-visible-where.js";

/** The canonical relation type that expresses project membership of an entity. */
export const BELONGS_TO_PROJECT = "belongs_to_project";

/**
 * Subquery: the project entity ids the user is a member of (via `project_members`).
 * Correlated/optimisable as a semi-join by Postgres — one round-trip regardless
 * of how many projects the user belongs to.
 */
function userProjectIdsSubquery(userId: string) {
  return db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));
}

/**
 * Subquery: entity ids that `belongs_to_project` one of the projects produced by
 * `targetProjectIds` (itself a subquery of project ids). `belongs_to_project`
 * edges are source=member → target=project, so the member ids are the
 * `source_entity_id`s.
 */
function belongsToAnyProjectSubquery(
  targetProjectIds: ReturnType<typeof userProjectIdsSubquery>
) {
  return db
    .select({ id: relations.sourceEntityId })
    .from(relations)
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        inArray(relations.targetEntityId, targetProjectIds)
      )
    );
}

/**
 * FLOOR BRANCH — rows (by entity id) the user can see THROUGH project membership.
 * Two cases, ORed:
 *   (a) the entity IS a project the user is a member of, or
 *   (b) the entity belongs_to a project the user is a member of.
 *
 * This is the third access source in the security floor (alongside the workspace
 * union and the pod-personal branch). It WIDENS access by design: a project
 * member sees that project's data even in workspaces they are not a member of —
 * and nothing else there (the branch only admits rows in their projects).
 *
 * Until `project_members.projectId` is repointed to `entities.id` (migration
 * 0134) this branch matches nothing (legacy ids won't collide with entity ids),
 * so it is safe to land ahead of the migration — it simply grants no project
 * access yet.
 */
export function projectMemberWhere(
  entityIdColumn: AnyPgColumn,
  userId: string
): SQL {
  // Build the user's project-id subquery ONCE and reuse it for both branches —
  // distinct Drizzle subquery instances emit duplicate SQL (a second redundant
  // scan of project_members on a predicate that runs on every entity read).
  const projectIds = userProjectIdsSubquery(userId);
  return or(
    inArray(entityIdColumn, projectIds),
    inArray(entityIdColumn, belongsToAnyProjectSubquery(projectIds))
  )!;
}

/**
 * NARROWING LENS — restrict to a single project. Matches the project entity
 * itself plus everything that `belongs_to` it.
 *
 * PURE narrowing: this MUST be ANDed with the access floor by the caller
 * (`accessScopeWhere`). On its own it does not enforce access — a forged/stale
 * project id only restricts the result set; intersected with the floor it can
 * never reveal a row the user could not already see. Mirrors the
 * "lens only narrows" contract of `workspaceLensWhere`.
 */
export function projectLensWhere(
  entityIdColumn: AnyPgColumn,
  projectLens: string
): SQL {
  const belongsToProject = db
    .select({ id: relations.sourceEntityId })
    .from(relations)
    .where(
      and(
        eq(relations.type, BELONGS_TO_PROJECT),
        eq(relations.targetEntityId, projectLens)
      )
    );
  return or(
    eq(entityIdColumn, projectLens),
    inArray(entityIdColumn, belongsToProject)
  )!;
}

/**
 * THE SEAM — the one unified access predicate for a DATA table (entities is the
 * canonical caller; documents/artifacts share the shape). Every DATA-table read
 * passes through this. Composition:
 *
 *   floor  (security — ALWAYS):  pod-personal OR workspace-access OR project-membership
 *   AND workspace lens (optional narrow)
 *   AND project lens   (optional narrow)
 *
 * The floor is the existing entity floor (pod-personal + workspace union)
 * EXTENDED with the project-membership branch — so a project member sees their
 * project's data across workspaces. Both lenses ONLY narrow (intersected with
 * the floor, never widening). This replaces the ad-hoc
 * `entityVisibleWhere` / `entityLensWhere` once entities adopt it (Phase 2);
 * LENS-CONFIG tables do NOT use this — they scope on workspace only via scopedDb.
 *
 * PRECONDITION — DATA tables only, where `workspaceId IS NULL` means "personal to
 * `ownerColumn`" (entities, documents, artifacts all satisfy this). The
 * pod-personal floor branch and the `workspaceLens === null` ("globals-only")
 * narrow both gate null-workspace rows by `ownerColumn`; a table where a null
 * workspace does NOT imply owner-personal must NOT use this resolver.
 *
 * @param ownerColumn   the per-user owner column (e.g. `entities.userId`) — gates
 *                      the pod-personal (workspaceId IS NULL) rows to their owner.
 * @param workspaceLens 3-state: `undefined` = no narrow · `null` = pod-personal
 *                      only · `"<id>"` = that workspace (+ the user floor).
 * @param projectLens   `undefined`/`null` = no narrow · `"<projectEntityId>"` =
 *                      that project (the project entity + everything belonging to it).
 */
export function accessScopeWhere(args: {
  workspaceIdColumn: AnyPgColumn;
  entityIdColumn: AnyPgColumn;
  ownerColumn: AnyPgColumn;
  userId: string;
  workspaceLens?: string | null | undefined;
  projectLens?: string | null | undefined;
}): SQL {
  const {
    workspaceIdColumn,
    entityIdColumn,
    ownerColumn,
    userId,
    workspaceLens,
    projectLens,
  } = args;

  // ── Floor (security) — the union of all the ways the user may see a row. ──
  const podPersonal = and(isNull(workspaceIdColumn), eq(ownerColumn, userId))!;
  const floor = or(
    podPersonal,
    // `isNotNull` guard so the workspace union doesn't re-admit the NULL rows
    // the pod-personal branch already (correctly, owner-gated) covers.
    and(
      isNotNull(workspaceIdColumn),
      userVisibleWhere(workspaceIdColumn, userId)
    )!,
    projectMemberWhere(entityIdColumn, userId)
  )!;

  // ── Workspace lens (optional narrow) ──────────────────────────────────────
  let workspaceNarrow: SQL | undefined;
  if (workspaceLens === null) {
    // Globals-only, for entities, means the pod-personal rows.
    workspaceNarrow = podPersonal;
  } else if (workspaceLens !== undefined) {
    workspaceNarrow = workspaceLensWhere(
      workspaceIdColumn,
      userId,
      workspaceLens
    );
  }

  // ── Project lens (optional narrow) ────────────────────────────────────────
  const projectNarrow =
    projectLens == null
      ? undefined
      : projectLensWhere(entityIdColumn, projectLens);

  return and(floor, workspaceNarrow, projectNarrow)!;
}
