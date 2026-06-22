/**
 * `project-scope` — the EXPOSURE axis of the unified access seam.
 *
 * The deliberate mirror of `user-visible-where.ts` (the WORKSPACE axis). Where
 * workspace is a lens keyed on `workspace_id`, exposure is a cross-cutting data
 * scope keyed on the entity graph: an entity is "exposed to" an anchor iff it IS
 * that anchor entity, or it has a **whitelisted exposure edge** pointing at it
 * (source = exposed row, target = anchor entity). Anchor membership lives in the
 * `project_members` table (keyed on the anchor ENTITY id after the 0134 repoint),
 * so it is a fast indexed access-join — exactly like `workspace_members` for the
 * workspace axis.
 *
 * Two whitelisted exposure edges (`EXPOSURE_RELATION_TYPES`):
 *   - `belongs_to_project` — an entity belongs to a project (the original axis).
 *   - `visible_to`         — the GENERIC exposure edge: expose ANY entity (a page,
 *      a deal, a doc, an artifact) to ANY anchor (a client, a portal). This is the
 *      substrate for client portals / multi-tenant. ONLY these explicit edges
 *      grant exposure — an incidental `mentions`/`related_to` link does NOT
 *      (relation-type whitelist = the safety guarantee).
 *
 * Two roles, both as composable Drizzle predicates over an ENTITY-ID column:
 *   - `exposureMemberWhere` — the FLOOR's third access source: rows the user may
 *      see because they are a member of the owning anchor. ORed into the access
 *      floor alongside the workspace union + pod-personal branch.
 *   - `exposureLensWhere`   — the optional NARROWING lens to a single anchor.
 *      PURE: it must be ANDed with the access floor by the caller
 *      (`accessScopeWhere`); on its own it only narrows and can never widen.
 *
 * `projectMemberWhere` / `projectLensWhere` are kept as behaviour-preserving
 * presets (relationType = `belongs_to_project`) so the project axis is unchanged.
 *
 * Both operate on whichever entity-id column the table exposes (e.g.
 * `entities.id`). Tables without an entity-graph identity (LENS-CONFIG tables
 * like views/property_defs) do NOT use this axis — see the per-table axis map in
 * team/platform/project-centric-scope.mdx.
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
 * The GENERIC exposure edge — "this entity is exposed to that anchor". The
 * generalization of project membership to ANY anchor entity (a client, a portal).
 * Source = exposed row, target = anchor. Only this whitelisted edge grants
 * exposure; an incidental link (`mentions`, `related_to`, …) does NOT.
 */
export const VISIBLE_TO = "visible_to";

/**
 * The relation types that grant access through the EXPOSURE axis. Anchor
 * membership admits (a) the anchor entity itself and (b) any row carrying one of
 * these edges to it. `belongs_to_project` keeps projects working; `visible_to` is
 * the generic client/portal exposure edge. Whitelist = the leak guardrail: adding
 * a type here is a deliberate, reviewable widening of what counts as "exposed".
 */
export const EXPOSURE_RELATION_TYPES = [BELONGS_TO_PROJECT, VISIBLE_TO] as const;

/**
 * The whitelist as a TYPE — so the type system (not just a runtime default)
 * refuses an arbitrary relation (`"mentions"`, `"related_to"`) at every call
 * site. Widening exposure = adding a member to `EXPOSURE_RELATION_TYPES`, a
 * deliberate + reviewable edit. A caller CANNOT pass an off-whitelist edge.
 */
export type ExposureRelationType = (typeof EXPOSURE_RELATION_TYPES)[number];

/**
 * Subquery: the anchor entity ids the user is a member of (via `project_members`,
 * the generic anchor-membership table post-0134). Correlated/optimisable as a
 * semi-join by Postgres — one round-trip regardless of how many anchors.
 */
function userAnchorIdsSubquery(userId: string) {
  return db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, userId));
}

/**
 * Subquery: entity ids that carry one of `relationTypes` (an exposure edge) to
 * one of the anchors in `anchorIds`. Exposure edges are source=exposed-row →
 * target=anchor, so the exposed-row ids are the `source_entity_id`s.
 */
function exposedByAnyAnchorSubquery(
  anchorIds: ReturnType<typeof userAnchorIdsSubquery>,
  relationTypes: readonly ExposureRelationType[]
) {
  return db
    .select({ id: relations.sourceEntityId })
    .from(relations)
    .where(
      and(
        inArray(relations.type, [...relationTypes]),
        inArray(relations.targetEntityId, anchorIds)
      )
    );
}

/**
 * FLOOR BRANCH — rows (by entity id) the user can see THROUGH anchor membership,
 * over the given exposure `relationTypes` (default: both project + visible_to).
 * Two cases, ORed:
 *   (a) the entity IS an anchor the user is a member of, or
 *   (b) the entity has an exposure edge to an anchor the user is a member of.
 *
 * This is the third access source in the security floor (alongside the workspace
 * union and the pod-personal branch). It WIDENS access by design: an anchor
 * member sees that anchor's exposed data even in workspaces they are not a member
 * of — and nothing else there (the branch only admits rows exposed to their
 * anchors).
 *
 * Until `project_members.projectId` is repointed to `entities.id` (migration
 * 0134) this branch matches nothing (legacy ids won't collide with entity ids),
 * so it is safe to land ahead of the migration — it simply grants no exposure
 * access yet. Likewise it is dormant until `visible_to` edges actually exist.
 */
export function exposureMemberWhere(
  entityIdColumn: AnyPgColumn,
  userId: string,
  relationTypes: readonly ExposureRelationType[] = EXPOSURE_RELATION_TYPES
): SQL {
  // Build the user's anchor-id subquery ONCE and reuse it for both branches —
  // distinct Drizzle subquery instances emit duplicate SQL (a second redundant
  // scan of project_members on a predicate that runs on every entity read).
  const anchorIds = userAnchorIdsSubquery(userId);
  return or(
    inArray(entityIdColumn, anchorIds),
    inArray(entityIdColumn, exposedByAnyAnchorSubquery(anchorIds, relationTypes))
  )!;
}

/**
 * NARROWING LENS — restrict to a single anchor over the given exposure
 * `relationTypes`. Matches the anchor entity itself plus everything with an
 * exposure edge to it.
 *
 * PURE narrowing: this MUST be ANDed with the access floor by the caller
 * (`accessScopeWhere`). On its own it does not enforce access — a forged/stale
 * anchor id only restricts the result set; intersected with the floor it can
 * never reveal a row the user could not already see. Mirrors the
 * "lens only narrows" contract of `workspaceLensWhere`.
 */
export function exposureLensWhere(
  entityIdColumn: AnyPgColumn,
  anchorLens: string,
  relationTypes: readonly ExposureRelationType[] = EXPOSURE_RELATION_TYPES
): SQL {
  const exposedToAnchor = db
    .select({ id: relations.sourceEntityId })
    .from(relations)
    .where(
      and(
        inArray(relations.type, [...relationTypes]),
        eq(relations.targetEntityId, anchorLens)
      )
    );
  return or(
    eq(entityIdColumn, anchorLens),
    inArray(entityIdColumn, exposedToAnchor)
  )!;
}

/**
 * PROJECT-axis preset of `exposureMemberWhere` (relationType =
 * `belongs_to_project`). Behaviour-preserving — kept so existing callers and the
 * project-centric-scope semantics are unchanged.
 */
export function projectMemberWhere(
  entityIdColumn: AnyPgColumn,
  userId: string
): SQL {
  return exposureMemberWhere(entityIdColumn, userId, [BELONGS_TO_PROJECT]);
}

/**
 * PROJECT-axis preset of `exposureLensWhere` (relationType =
 * `belongs_to_project`). Behaviour-preserving.
 */
export function projectLensWhere(
  entityIdColumn: AnyPgColumn,
  projectLens: string
): SQL {
  return exposureLensWhere(entityIdColumn, projectLens, [BELONGS_TO_PROJECT]);
}

/**
 * THE SEAM — the one unified access predicate for a DATA table (entities is the
 * canonical caller; documents/artifacts share the shape). Every DATA-table read
 * passes through this. Composition:
 *
 *   floor  (security — ALWAYS):  pod-personal OR workspace-access OR exposure-membership
 *   AND workspace lens (optional narrow)
 *   AND project/anchor lens   (optional narrow)
 *
 * The floor is the existing entity floor (pod-personal + workspace union)
 * EXTENDED with the EXPOSURE-membership branch (both `belongs_to_project` and
 * `visible_to`) — so an anchor member (project member OR client) sees their
 * anchor's exposed data across workspaces. Both lenses ONLY narrow (intersected
 * with the floor, never widening). This replaces the ad-hoc
 * `entityVisibleWhere` / `entityLensWhere` once entities adopt it (Phase 1);
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
 * @param projectLens   `undefined`/`null` = no narrow · `"<anchorEntityId>"` =
 *                      that anchor (the anchor entity + everything exposed to it).
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
    // Exposure membership over BOTH axes (project + visible_to) — dormant until
    // anchors/edges exist, so this is additive (no behaviour change today).
    exposureMemberWhere(entityIdColumn, userId, EXPOSURE_RELATION_TYPES)
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

  // ── Project/anchor lens (optional narrow) ─────────────────────────────────
  const projectNarrow =
    projectLens == null
      ? undefined
      : exposureLensWhere(entityIdColumn, projectLens, EXPOSURE_RELATION_TYPES);

  return and(floor, workspaceNarrow, projectNarrow)!;
}
