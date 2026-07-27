/**
 * `project-scope` — the EXPOSURE axis of the unified access seam.
 *
 * The deliberate mirror of `user-visible-where.ts` (the WORKSPACE axis). Where
 * workspace is a lens keyed on `workspace_id`, exposure is a cross-cutting data
 * scope keyed on the entity graph: an entity is "exposed to" an anchor iff it IS
 * that anchor entity, or it has a **whitelisted exposure edge** pointing at it
 * (source = exposed row, target = anchor entity). Anchor membership lives in the
 * `project_members` table (keyed on `projects.id`), so it is a fast indexed
 * access-join — exactly like `workspace_members` for the workspace axis.
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
import {
  projectMembers,
  relations,
  entityFacets,
  workspaceMembers,
} from "@synap/database/schema";
import {
  userVisibleWhere,
  workspaceLensWhere,
  podMemberWhere,
  type WorkspaceLens,
} from "./user-visible-where.js";

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
export const EXPOSURE_RELATION_TYPES = [
  BELONGS_TO_PROJECT,
  VISIBLE_TO,
] as const;

/**
 * The whitelist as a TYPE — so the type system (not just a runtime default)
 * refuses an arbitrary relation (`"mentions"`, `"related_to"`) at every call
 * site. Widening exposure = adding a member to `EXPOSURE_RELATION_TYPES`, a
 * deliberate + reviewable edit. A caller CANNOT pass an off-whitelist edge.
 */
export type ExposureRelationType = (typeof EXPOSURE_RELATION_TYPES)[number];

/**
 * Subquery: the anchor ids the user is a member of (via `project_members`, keyed
 * on `projects.id`). Correlated/optimisable as a semi-join by Postgres — one
 * round-trip regardless of how many anchors.
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
 * Project exposure is live: anchors are `projects.id` (`project_members.projectId`
 * → `projects.id`), and exposure edges target that same id.
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
    inArray(
      entityIdColumn,
      exposedByAnyAnchorSubquery(anchorIds, relationTypes)
    )
  )!;
}

/**
 * Subquery: entity ids that carry a facet (a role/overlay) in a workspace the
 * user is a MEMBER of. `entity_facets.workspace_id` joined to
 * `workspace_members.workspace_id` — a NULL facet workspace never joins (NULL =
 * NULL is not TRUE in SQL), so pod-wide facets grant no lens access. Semi-join,
 * one round-trip regardless of facet count.
 */
function facetLensedEntityIdsSubquery(userId: string) {
  return (
    db
      .select({ id: entityFacets.entityId })
      .from(entityFacets)
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, entityFacets.workspaceId)
      )
      // `entity_facets` is soft-delete only (detach sets `deletedAt`, never hard
      // deletes). Without this, a REVOKED role would keep granting the lens forever
      // — every other reader filters it; this is the access-revocation gate.
      .where(
        and(eq(workspaceMembers.userId, userId), isNull(entityFacets.deletedAt))
      )
  );
}

/**
 * FLOOR BRANCH — the ROLE-AS-LENS share grant (Membership → Visibility). An
 * entity is visible to `userId` when it carries a facet (a role/overlay) in a
 * workspace `userId` is a member of. This is the mechanism behind "entity =
 * pod-wide identity; roles = the workspace lens": attaching a role to an entity
 * in a shared workspace both curates it into that workspace's view AND grants
 * that workspace's members read — while an un-roled pod-wide entity stays
 * owner-private (this branch admits nothing for it).
 *
 * WIDENING-ONLY, by construction: it is ORed into the floor and can only ADD an
 * entity the owner EXPLICITLY gave a workspace-role. It never removes a row, and
 * it never admits a private (un-faceted, NULL-workspace) entity — so it cannot
 * leak a solo user's private corpus. Gated on real `workspace_members`
 * membership, symmetric across users (binds the caller's id, never a row owner).
 *
 * Applied ONLY where an entity-id column actually maps to `entity_facets.entity_id`
 * (the `entities` rule) — opt-in via `accessScopeWhere({ facetLens: true })`, so
 * tables without entity-facet identity (documents, …) are unaffected.
 */
export function facetLensMemberWhere(
  entityIdColumn: AnyPgColumn,
  userId: string
): SQL {
  return inArray(entityIdColumn, facetLensedEntityIdsSubquery(userId));
}

/**
 * FLOOR BRANCH — the POD-LEVEL twin of `facetLensMemberWhere` (Membership →
 * Visibility, Wave 2). `facetLensMemberWhere` grants a WORKSPACE's members read
 * on an entity that carries a facet in THAT workspace; a POD-WIDE facet
 * (`entity_facets.workspace_id IS NULL`) joins no workspace, so before this
 * branch it granted nobody anything and a pod-wide role (a `client` facet on a
 * pod-scoped company, say) was visible only to the run owner.
 *
 * SHARED-TO-POD is defined as: the ENTITY is itself pod-wide
 * (`workspace_id IS NULL`) AND it carries a LIVE pod-wide facet. There is no
 * per-facet private flag, so the pod-wide facet IS the share signal — exactly as
 * a workspace facet is the workspace share signal. The caller must additionally
 * be a `pod_members` row (`podMemberWhere`).
 *
 * WIDENING-ONLY and NARROW BY CONSTRUCTION:
 *   - it is ORed into the floor — it never removes a row;
 *   - it requires a pod-wide row, so it can NEVER admit a workspace-scoped
 *     (`workspace_id` non-null) row — no workspace data is widened;
 *   - it requires an explicit, live facet attachment, so an UN-FACETED pod-wide
 *     entity stays owner-private under `podPersonal`;
 *   - it binds the CALLER's id only (symmetric across users, never a row owner);
 *   - a non-pod-member matches nothing (the EXISTS is false) — fail closed.
 */
export function podSharedFacetWhere(
  workspaceIdColumn: AnyPgColumn,
  entityIdColumn: AnyPgColumn,
  userId: string
): SQL {
  const podWideFacetedEntityIds = db
    .select({ id: entityFacets.entityId })
    .from(entityFacets)
    .where(
      and(
        isNull(entityFacets.workspaceId),
        // Soft-delete gate — a DETACHED role must stop sharing the entity.
        isNull(entityFacets.deletedAt)
      )
    );
  return and(
    isNull(workspaceIdColumn),
    inArray(entityIdColumn, podWideFacetedEntityIds),
    podMemberWhere(userId)
  )!;
}

/**
 * NARROW COMPANION to `facetLensMemberWhere` — entity ids that carry a facet in
 * one of the lens workspace(s). Used to make the workspace LENS facet-aware for
 * entities: browsing workspace W surfaces a pod-wide entity that has a role in W
 * (not just entities whose OWN `workspace_id = W`). PURE narrow — it is ORed into
 * the workspace narrow, which is itself ANDed with the membership-gated floor, so
 * SELF-GATING: it joins `workspace_members` on the LENS workspace(s) for
 * `userId`, so it only surfaces an entity role-attached to a lens workspace the
 * caller is ACTUALLY a member of. This must NOT rely on the outer floor for
 * membership: the floor's `facetLensMemberWhere` admits an entity with a facet in
 * ANY member workspace, which may differ from the lens workspace — so without this
 * join, a caller could pass a forged `input.workspaceId` (never membership-checked
 * on `podProcedure`) for a workspace W they are NOT in and surface an entity that
 * merely has a role in W, as long as it also has a role in some workspace they ARE
 * in. Gating on lens-workspace membership here closes that cross-boundary leak.
 */
export function facetInWorkspaceLensWhere(
  entityIdColumn: AnyPgColumn,
  userId: string,
  lens: string | string[]
): SQL {
  const ids = Array.isArray(lens) ? lens : [lens];
  const sub = db
    .select({ id: entityFacets.entityId })
    .from(entityFacets)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, entityFacets.workspaceId)
    )
    .where(
      and(
        inArray(entityFacets.workspaceId, ids),
        // The caller must be a member of the LENS workspace the facet is in.
        eq(workspaceMembers.userId, userId),
        // Soft-delete gate: a revoked role must stop surfacing the entity.
        isNull(entityFacets.deletedAt)
      )
    );
  return inArray(entityIdColumn, sub);
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
  anchorLens: string | string[],
  relationTypes: readonly ExposureRelationType[] = EXPOSURE_RELATION_TYPES
): SQL {
  // Multi-valued: a SET of anchors = OR (union) — match any of them, plus
  // anything exposed to any of them. A single id keeps the original eq path.
  const anchors = Array.isArray(anchorLens) ? anchorLens : [anchorLens];
  const exposedToAnchor = db
    .select({ id: relations.sourceEntityId })
    .from(relations)
    .where(
      and(
        inArray(relations.type, [...relationTypes]),
        inArray(relations.targetEntityId, anchors)
      )
    );
  return or(
    inArray(entityIdColumn, anchors),
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
  projectLens: string | string[]
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
  workspaceLens?: WorkspaceLens;
  /**
   * `undefined`/`null` = no narrow · `"<id>"` or `string[]` = that anchor (or
   * SET of anchors, OR/union) — the anchor entity(s) + everything exposed to
   * them. Multi-valued so a caller can fetch across several projects at once.
   */
  projectLens?: string | string[] | null | undefined;
  /**
   * OPTIONAL floor restriction — narrow the EXPOSURE branch of the floor to a
   * SUBSET of `EXPOSURE_RELATION_TYPES` (e.g. `[VISIBLE_TO]` for a portal
   * guest whose access is explicit-share only). Default = the full whitelist,
   * so every existing caller is behavior-preserving. Unlike the lenses this is
   * part of the FLOOR: it can only REMOVE an access source, never add one —
   * enforced by the `ExposureRelationType` type plus a runtime subset check.
   */
  exposureRelationTypes?: readonly ExposureRelationType[];
  /**
   * Opt-in (default OFF) — add the ROLE-AS-LENS floor branch: an entity is
   * visible when it carries a facet in a workspace the caller is a member of
   * (`facetLensMemberWhere`). Enable ONLY on tables whose `entityIdColumn` maps
   * to `entity_facets.entity_id` (the `entities` rule). Widening-only: it can
   * add a role-shared entity, never remove a row nor admit an un-faceted private
   * one.
   */
  facetLens?: boolean;
  /**
   * Opt-in (default OFF) — when a SPECIFIC workspace lens is set, ALSO include
   * pod-wide globals (`workspace_id IS NULL`) in the narrow, instead of that
   * workspace only. Reproduces the hand-rolled `includePodWide` union
   * (`or(pod-personal, that-workspace)`) some entity readers used. Threads
   * `{ includeGlobals: true }` into `workspaceLensWhere`; no effect when the lens
   * is `undefined` (already user-wide) or `null` (globals-only).
   */
  includeGlobalsInLens?: boolean;
}): SQL {
  const {
    workspaceIdColumn,
    entityIdColumn,
    ownerColumn,
    userId,
    workspaceLens,
    projectLens,
    exposureRelationTypes = EXPOSURE_RELATION_TYPES,
    facetLens = false,
    includeGlobalsInLens = false,
  } = args;

  // Narrow-only guard. The type already refuses off-whitelist strings at every
  // TS call site; this runtime check holds the line for untyped (JS / cast)
  // callers, and refuses an EMPTY list (which would silently drop the exposure
  // branch — omit the option instead if you want the default whitelist).
  if (exposureRelationTypes.length === 0) {
    throw new Error(
      "accessScopeWhere: exposureRelationTypes must not be empty — omit the option for the default whitelist"
    );
  }
  for (const t of exposureRelationTypes) {
    if (!EXPOSURE_RELATION_TYPES.includes(t)) {
      throw new Error(
        `accessScopeWhere: exposureRelationTypes may only narrow the exposure whitelist (got "${t}")`
      );
    }
  }

  // ── Floor (security) — the union of all the ways the user may see a row. ──
  const podPersonal = and(isNull(workspaceIdColumn), eq(ownerColumn, userId))!;
  const floorBranches: SQL[] = [
    podPersonal,
    // `isNotNull` guard so the workspace union doesn't re-admit the NULL rows
    // the pod-personal branch already (correctly, owner-gated) covers.
    and(
      isNotNull(workspaceIdColumn),
      userVisibleWhere(workspaceIdColumn, userId)
    )!,
    // Exposure membership — admits rows the user sees via anchor membership
    // (`projects.id`) + exposure edges. Default = BOTH axes (project +
    // visible_to); a caller-supplied `exposureRelationTypes` NARROWS this
    // branch (portal guests: `visible_to` only).
    exposureMemberWhere(entityIdColumn, userId, exposureRelationTypes),
  ];
  // Role-as-lens (opt-in, `entities` only): a pod-wide entity becomes visible to
  // a workspace's members once it carries a facet there. Widening-only; an
  // un-faceted NULL-workspace entity stays owner-gated by `podPersonal` above.
  if (facetLens) {
    floorBranches.push(facetLensMemberWhere(entityIdColumn, userId));
  }
  // POD-shared (Wave 2): the pod-level twin of role-as-lens — a pod-wide entity
  // carrying a LIVE pod-wide facet is shared with the pod's members. Same opt-in
  // gate as `facetLens` (it reads `entity_facets.entity_id`, so it is only valid
  // where `entityIdColumn` maps to it). Widening-only, pod-wide rows only; an
  // un-faceted pod-wide entity stays owner-gated by `podPersonal`.
  const podShared = facetLens
    ? podSharedFacetWhere(workspaceIdColumn, entityIdColumn, userId)
    : undefined;
  if (podShared) floorBranches.push(podShared);
  const floor = or(...floorBranches)!;

  // ── Workspace lens (optional narrow) ──────────────────────────────────────
  // `null` = globals-only (pod-personal rows). An empty array = no narrow (the
  // floor), matching workspaceLensWhere — an empty filter must never match zero.
  const wsEmpty = Array.isArray(workspaceLens) && workspaceLens.length === 0;
  let workspaceNarrow: SQL | undefined;
  if (workspaceLens === null) {
    // `null` lens = the POD view. Historically this was the owner's pod-personal
    // rows ONLY, which re-imposed the owner floor on top of the (already
    // widened) floor and hid pod-SHARED rows from every non-owner. The narrow is
    // now "pod-wide rows I may see": my own, plus the pod-shared ones. Still a
    // NARROW — both branches require `workspace_id IS NULL`, and it is ANDed with
    // the floor, which carries the identical `podShared` branch.
    workspaceNarrow = podShared ? or(podPersonal, podShared)! : podPersonal;
  } else if (workspaceLens !== undefined && !wsEmpty) {
    const lensNarrow = workspaceLensWhere(
      workspaceIdColumn,
      userId,
      workspaceLens,
      includeGlobalsInLens ? { includeGlobals: true } : undefined
    );
    // Role-as-lens (entities only): a workspace's view also surfaces a pod-wide
    // entity that carries a facet in that workspace — not just entities whose own
    // `workspace_id` matches. ORed narrow, still ANDed with the membership-gated
    // floor, so it can only surface an entity the floor already admits.
    // `workspaceLens` is neither undefined nor null here (handled above), so the
    // facet-aware narrow applies whenever facetLens is on.
    workspaceNarrow = facetLens
      ? or(
          lensNarrow,
          facetInWorkspaceLensWhere(entityIdColumn, userId, workspaceLens)
        )!
      : lensNarrow;
  }

  // ── Project/anchor lens (optional narrow) ─────────────────────────────────
  const projEmpty = Array.isArray(projectLens) && projectLens.length === 0;
  const projectNarrow =
    projectLens == null || projEmpty
      ? undefined
      : exposureLensWhere(entityIdColumn, projectLens, EXPOSURE_RELATION_TYPES);

  return and(floor, workspaceNarrow, projectNarrow)!;
}
