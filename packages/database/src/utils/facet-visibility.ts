/**
 * Canonical visibility predicate for entity_facets reads — the ONE place the
 * workspace-lens + owner-floor semantics live. Used by both
 * FacetRepository.getByEntity/listByProfile and getEffectiveFacets so the
 * two read paths cannot drift.
 *
 * POLICY (the single-lens twin of the access-layer rule registered for
 * entityFacets in packages/api access/registry.ts — keep the two in sync):
 * workspace-scoped facets are shared with the workspace's members (the caller
 * has already verified membership on the lens it passes here); pod-wide
 * (null-workspace) facets carry an OWNER floor, widened (decision B) to a pod
 * member in a SPACE THE FACET'S ROLE IS GRANTED TO (`podSharedFacetGrantWhere`)
 * — never to every pod member. A non-pod-member still sees only their own
 * (fail closed).
 * - lens `undefined` → all lenses, optionally bounded by allowedWorkspaceIds
 * - lens `null`      → base-only (facets with no workspace)
 * - lens `string`    → that workspace's facets + pod-wide (null-workspace) ones
 */

import { type SQL, and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db } from "../client-pg.js";
import { entityFacets } from "../schema/entity-facets.js";
import { profiles, profileWorkspaceAccess } from "../schema/profiles.js";
import { podMemberWhere } from "./pod-membership.js";
import { memberWorkspaceIds, ownedWorkspaceIds } from "./user-visible-where.js";

// ─── SHARED-ROLE VISIBILITY (founder decision B, 2026-09-27) ──────────────────
//
// A shared/system role's facet is STORED pod-wide (NULL — `storedFacetWorkspaceId`
// below), so the facet row itself names no workspace. Until decision B a live
// pod-wide facet was read as "shared with EVERY pod member", which meant
// attaching `client` to a private person published that person (and its
// document) to the whole team pod.
//
// DECISION B: a pod-wide facet shares its row — and the pod-wide entity wearing
// it, and that entity's document — ONLY with a pod member who belongs to (is a
// member of, or owns) a SPACE THE ROLE IS GRANTED TO. "Granted to" is the role's
// own workspace grants: a `profile_workspace_access` row, or the role's owning
// workspace (`profiles.workspace_id`). There is NO implicit all-spaces grant for
// a `system` role — a system role shares only where it is explicitly granted
// (the one seeded system role, `team-member`, keeps its per-workspace lens and
// never reaches this rule). The owner floor is separate and unchanged, so a
// solo pod (owner only) sees exactly what it saw before.
//
// These three builders are THE predicate. Every reader that asks "is this
// pod-wide facet / entity / document shared with the caller?" composes them:
//   - `facetVisibilityConditions` (below) and its in-memory twin
//     `isFacetVisibleForLens` (via `resolveViewerSharedRoleIds`);
//   - the `entityFacets` VisibilityRule (packages/api access/registry.ts);
//   - `podSharedFacetWhere` / `podSharedDocumentWhere`
//     (packages/api utils/project-scope.ts — entity + document floors);
//   - `entityQueryVisibilityWhere` (packages/jobs workers/entity-query-scope.ts).
// All three are UNCORRELATED subqueries bound to the caller's id, so they render
// identically under `db.select()` and relational (`db.query`) reads.

/**
 * Role (profile) ids granted to a space `userId` belongs to (member or owner):
 * a `profile_workspace_access` grant, or the role's own owning workspace.
 */
export function grantedRoleIdsFor(userId: string) {
  const mySpaces = or(
    inArray(profileWorkspaceAccess.workspaceId, memberWorkspaceIds(userId)),
    inArray(profileWorkspaceAccess.workspaceId, ownedWorkspaceIds(userId))
  );
  return db
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      or(
        inArray(
          profiles.id,
          db
            .select({ id: profileWorkspaceAccess.profileId })
            .from(profileWorkspaceAccess)
            .where(mySpaces)
        ),
        inArray(profiles.workspaceId, memberWorkspaceIds(userId)),
        inArray(profiles.workspaceId, ownedWorkspaceIds(userId))
      )
    );
}

/**
 * THE row predicate over `entity_facets`: this POD-WIDE facet is shared with
 * `userId` — a pod member in a space its role is granted to (decision B).
 * Does not include the owner floor (callers OR it with `eq(userId)`), nor the
 * soft-delete gate (a facet READ may show a detached row to its owner; the
 * entity/document SHARE subquery adds `deletedAt IS NULL`).
 */
export function podSharedFacetGrantWhere(userId: string): SQL {
  return and(
    isNull(entityFacets.workspaceId),
    inArray(entityFacets.profileId, grantedRoleIdsFor(userId)),
    podMemberWhere(userId)
  )!;
}

/**
 * Entity ids SHARED with `userId` by a LIVE pod-wide facet (decision B). The
 * entity floor still requires the entity itself be pod-wide.
 */
export function podSharedEntityIdsFor(userId: string) {
  return db
    .select({ id: entityFacets.entityId })
    .from(entityFacets)
    .where(
      and(
        podSharedFacetGrantWhere(userId),
        // Soft-delete gate — a DETACHED role must stop sharing the entity.
        isNull(entityFacets.deletedAt)
      )
    );
}

/**
 * JS form of the grant half of {@link podSharedFacetGrantWhere} for code that
 * holds already-loaded facet rows (`isFacetVisibleForLens`). Runs the SAME
 * builders, so the two cannot disagree. Empty when the caller is not a pod
 * member (the EXISTS is false) — fail closed. `database` is the caller's
 * executor (the request's `db`), so the read runs where the caller's reads run.
 */
export async function resolveViewerSharedRoleIds(
  database: typeof db,
  userId: string
): Promise<Set<string>> {
  const rows = await database
    .select({ id: profiles.id })
    .from(profiles)
    .where(
      and(
        inArray(profiles.id, grantedRoleIdsFor(userId)),
        podMemberWhere(userId)
      )
    );
  return new Set(rows.map((r) => r.id));
}

/**
 * In-memory twin of {@link facetVisibilityConditions} for the string / null lens
 * cases — the ONE place the "is this facet visible under this lens?" rule lives
 * for code that has already-loaded facet rows (e.g. the proposal-review enrich)
 * rather than a SQL WHERE. Keep the two derivations in lockstep: this predicate
 * IS the boolean form of the same two SQL clauses.
 *
 *   - lens `null`   → facet.workspaceId IS NULL
 *                       AND (userId === viewer OR role ∈ viewerSharedRoleIds)
 *   - lens `string` → (facet.workspaceId === lens OR NULL)
 *                       AND (facet.workspaceId NOT NULL OR userId === viewer
 *                            OR role ∈ viewerSharedRoleIds)
 *
 * The workspace clause mirrors the `workspaceId === null` / `!== undefined`
 * branches; the AND'd owner-floor clause mirrors the always-appended
 * `or(isNotNull(workspaceId), eq(userId, viewer), podSharedFacetGrantWhere(viewer))`. (The
 * identity-wide `workspaceId === undefined` + `allowedWorkspaceIds` branch is
 * SQL-only — this in-memory helper is used where the lens is a concrete
 * workspace or pod-wide.)
 *
 * `viewerSharedRoleIds` is the JS form of the SQL grant term — resolve it ONCE
 * via `resolveViewerSharedRoleIds(db, viewer)` (same builders). It DEFAULTS TO EMPTY
 * so a caller that has not resolved it fails CLOSED to the owner floor, never
 * open. A facet row without `profileId` can only pass the owner floor.
 */
export function isFacetVisibleForLens(
  facet: {
    workspaceId: string | null;
    userId?: string | null;
    profileId?: string | null;
  },
  lensWorkspaceId: string | null,
  viewerUserId: string,
  viewerSharedRoleIds: ReadonlySet<string> = new Set()
): boolean {
  const workspaceMatch =
    lensWorkspaceId === null
      ? facet.workspaceId === null
      : facet.workspaceId === lensWorkspaceId || facet.workspaceId === null;
  const ownerFloor =
    facet.workspaceId !== null ||
    facet.userId === viewerUserId ||
    (!!facet.profileId && viewerSharedRoleIds.has(facet.profileId));
  return workspaceMatch && ownerFloor;
}

export function facetVisibilityConditions(opts: {
  userId: string;
  /**
   * INVARIANT (load-bearing, not enforced by this function): a concrete
   * `workspaceId` here is trusted to be a lens the caller has ALREADY verified
   * `userId` is a member of — this builder has no DB access of its own to
   * re-check membership, only row-shape SQL. All current callers
   * (`FacetRepository`, `facet-resolution-service`, `entities.ts`) resolve
   * `workspaceId` from a pre-authorized request context, never a raw
   * client-supplied value. A FUTURE caller passing an unchecked
   * client-supplied workspaceId here would leak that workspace's facets to a
   * non-member — verify membership (`AccessContext.podMembership()` /
   * `getWorkspaceMembership()`) BEFORE calling, do not rely on this function
   * to gate it.
   */
  workspaceId?: string | null;
  /** Access floor for an identity-wide read when workspaceId is undefined. */
  allowedWorkspaceIds?: string[];
}): SQL[] {
  // Cheap shape guard: "" is never a valid workspace id (the lens is either a
  // concrete id, `null` for pod-wide-only, or `undefined`/omitted for
  // identity-wide). It is not itself a leak — `eq(workspaceId, "")` matches no
  // row — but it is the TELL of an unvalidated request param forwarded
  // straight through (e.g. a missing query param defaulting to ""), which is
  // exactly the caller mistake this function cannot otherwise catch. Fail loud
  // here rather than let it silently return zero rows downstream.
  if (opts.workspaceId === "") {
    throw new Error(
      "facetVisibilityConditions: workspaceId must not be an empty string (use null for pod-wide-only, or omit for identity-wide)"
    );
  }

  const conditions: SQL[] = [];

  if (opts.workspaceId === undefined && opts.allowedWorkspaceIds) {
    conditions.push(
      opts.allowedWorkspaceIds.length > 0
        ? (or(
            inArray(entityFacets.workspaceId, opts.allowedWorkspaceIds),
            isNull(entityFacets.workspaceId)
          ) as SQL)
        : isNull(entityFacets.workspaceId)
    );
  } else if (opts.workspaceId === null) {
    conditions.push(isNull(entityFacets.workspaceId));
  } else if (opts.workspaceId !== undefined) {
    conditions.push(
      or(
        eq(entityFacets.workspaceId, opts.workspaceId),
        isNull(entityFacets.workspaceId)
      ) as SQL
    );
  }

  // Owner floor on the pod-wide (null-workspace) rows, widened (decision B) to
  // a pod member in a space the facet's role is granted to. The three branches:
  // workspace-scoped rows are already lensed above; pod-wide rows are admitted
  // for their owner, or via `podSharedFacetGrantWhere`. Keep in lockstep with the `entityFacets` VisibilityRule
  // (packages/api access/registry.ts) and `podSharedFacetWhere`
  // (packages/api utils/project-scope.ts).
  conditions.push(
    or(
      isNotNull(entityFacets.workspaceId),
      eq(entityFacets.userId, opts.userId),
      podSharedFacetGrantWhere(opts.userId)
    ) as SQL
  );

  return conditions;
}

/**
 * WRITE-side twin of the lens rule (W2b, the ROLE principle): which
 * `entity_facets.workspace_id` a new facet is STORED with.
 *
 * A role is ONE per name, pod-wide: a `shared` role (granted to one or more
 * workspaces) or a `system` role is the same hat in every lens, so every entity
 * wearing it must be visible in all of them. A facet pinned to the workspace
 * that happened to attach it is invisible in every other lens that has the
 * role (`facetVisibilityConditions` lens W = W OR NULL), so such a facet is
 * always stored pod-wide (NULL) — whatever lens the caller attached from.
 * Workspace overlay properties still validate under the caller's lens; only
 * the stored stamp changes. Pod-wide rather than "the granted set" because a
 * grant added later must reach facets that already exist, and NULL is exactly
 * the stamp both read predicates (this file + the access-layer VisibilityRule)
 * already show in every lens — so neither read side changes.
 *
 * A `workspace`-scoped role (one workspace's private hat) keeps the caller's
 * lens. Unknown scope → the caller's lens (never widen what we cannot classify).
 *
 * EXCEPTION — a PER-WORKSPACE role (`roleCategory` =
 * WORKSPACE_MEMBERSHIP_ROLE_CATEGORY, e.g. the system role `team-member`): its
 * profile is shared pod-wide, but the hat's MEANING is "member of THIS
 * workspace". One facet per workspace is the data, and removing a member from
 * one workspace must detach exactly that workspace's facet. It keeps the lens.
 */
export function storedFacetWorkspaceId(
  role: FacetRoleScope | null | undefined,
  requestedWorkspaceId: string | null
): string | null {
  return roleFacetIsPodWide(role) ? null : requestedWorkspaceId;
}

/**
 * `profiles.role_category` value marking a role whose meaning is per-workspace
 * (membership of the workspace the facet is stamped with). Such a role keeps
 * its lens even when its PROFILE is shared/system — see storedFacetWorkspaceId.
 * The facet-scope reconcile conversion excludes it for the same reason.
 */
export const WORKSPACE_MEMBERSHIP_ROLE_CATEGORY = "workspace-membership";

/** The two profile attributes the stored-lens rule reads. */
export interface FacetRoleScope {
  scope?: string | null;
  roleCategory?: string | null;
}

/**
 * THE rule: is this role's facet one hat pod-wide (stored NULL)? Shared/system
 * roles are, except a per-workspace membership role. Every writer that decides
 * a facet's lens (FacetRepository.attach, the facets.attach governance lens)
 * reads this, so they cannot disagree.
 */
export function roleFacetIsPodWide(
  role: FacetRoleScope | null | undefined
): boolean {
  if (!role) return false;
  if (role.roleCategory === WORKSPACE_MEMBERSHIP_ROLE_CATEGORY) return false;
  return role.scope === "shared" || role.scope === "system";
}
