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
 * (null-workspace) facets carry an OWNER floor, WIDENED in Wave 2 (Membership →
 * Visibility) to also admit any caller who is a POD MEMBER — a pod-wide facet is
 * the pod-level share signal, the twin of "a facet in workspace W is shared with
 * W's members". A non-pod-member still sees only their own (fail closed).
 * - lens `undefined` → all lenses, optionally bounded by allowedWorkspaceIds
 * - lens `null`      → base-only (facets with no workspace)
 * - lens `string`    → that workspace's facets + pod-wide (null-workspace) ones
 */

import { type SQL, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { entityFacets } from "../schema/entity-facets.js";
import { podMemberWhere } from "./pod-membership.js";

/**
 * In-memory twin of {@link facetVisibilityConditions} for the string / null lens
 * cases — the ONE place the "is this facet visible under this lens?" rule lives
 * for code that has already-loaded facet rows (e.g. the proposal-review enrich)
 * rather than a SQL WHERE. Keep the two derivations in lockstep: this predicate
 * IS the boolean form of the same two SQL clauses.
 *
 *   - lens `null`   → facet.workspaceId IS NULL
 *                       AND (userId === viewer OR viewerIsPodMember)
 *   - lens `string` → (facet.workspaceId === lens OR NULL)
 *                       AND (facet.workspaceId NOT NULL OR userId === viewer
 *                            OR viewerIsPodMember)
 *
 * The workspace clause mirrors the `workspaceId === null` / `!== undefined`
 * branches; the AND'd owner-floor clause mirrors the always-appended
 * `or(isNotNull(workspaceId), eq(userId, viewer), podMemberWhere(viewer))`. (The
 * identity-wide `workspaceId === undefined` + `allowedWorkspaceIds` branch is
 * SQL-only — this in-memory helper is used where the lens is a concrete
 * workspace or pod-wide.)
 *
 * `viewerIsPodMember` is the JS form of the SQL `EXISTS (pod_members)` term —
 * resolve it via `AccessContext.podMembership()`. It DEFAULTS TO FALSE so a
 * caller that has not resolved membership fails CLOSED to the owner floor (the
 * pre-Wave-2 behaviour), never open.
 */
export function isFacetVisibleForLens(
  facet: { workspaceId: string | null; userId?: string | null },
  lensWorkspaceId: string | null,
  viewerUserId: string,
  viewerIsPodMember = false
): boolean {
  const workspaceMatch =
    lensWorkspaceId === null
      ? facet.workspaceId === null
      : facet.workspaceId === lensWorkspaceId || facet.workspaceId === null;
  const ownerFloor =
    facet.workspaceId !== null ||
    facet.userId === viewerUserId ||
    viewerIsPodMember;
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

  // Owner floor on the pod-wide (null-workspace) rows, WIDENED to pod members
  // (Wave 2). The three branches: workspace-scoped rows are already lensed
  // above; pod-wide rows are admitted for their owner, or for any caller with a
  // `pod_members` row. Keep in lockstep with the `entityFacets` VisibilityRule
  // (packages/api access/registry.ts) and `podSharedFacetWhere`
  // (packages/api utils/project-scope.ts).
  conditions.push(
    or(
      isNotNull(entityFacets.workspaceId),
      eq(entityFacets.userId, opts.userId),
      podMemberWhere(opts.userId)
    ) as SQL
  );

  return conditions;
}
