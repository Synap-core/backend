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
 * (null-workspace) facets carry an OWNER floor and are visible only to their
 * owner.
 * - lens `undefined` → all lenses, optionally bounded by allowedWorkspaceIds
 * - lens `null`      → base-only (facets with no workspace)
 * - lens `string`    → that workspace's facets + pod-wide (null-workspace) ones
 */

import { type SQL, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { entityFacets } from "../schema/entity-facets.js";

/**
 * In-memory twin of {@link facetVisibilityConditions} for the string / null lens
 * cases — the ONE place the "is this facet visible under this lens?" rule lives
 * for code that has already-loaded facet rows (e.g. the proposal-review enrich)
 * rather than a SQL WHERE. Keep the two derivations in lockstep: this predicate
 * IS the boolean form of the same two SQL clauses.
 *
 *   - lens `null`   → facet.workspaceId IS NULL  AND  userId === viewer
 *   - lens `string` → (facet.workspaceId === lens OR NULL)
 *                       AND (facet.workspaceId NOT NULL OR userId === viewer)
 *
 * The workspace clause mirrors the `workspaceId === null` / `!== undefined`
 * branches; the AND'd owner-floor clause mirrors the always-appended
 * `or(isNotNull(workspaceId), eq(userId, viewer))`. (The identity-wide
 * `workspaceId === undefined` + `allowedWorkspaceIds` branch is SQL-only — this
 * in-memory helper is used where the lens is a concrete workspace or pod-wide.)
 */
export function isFacetVisibleForLens(
  facet: { workspaceId: string | null; userId?: string | null },
  lensWorkspaceId: string | null,
  viewerUserId: string
): boolean {
  const workspaceMatch =
    lensWorkspaceId === null
      ? facet.workspaceId === null
      : facet.workspaceId === lensWorkspaceId || facet.workspaceId === null;
  const ownerFloor =
    facet.workspaceId !== null || facet.userId === viewerUserId;
  return workspaceMatch && ownerFloor;
}

export function facetVisibilityConditions(opts: {
  userId: string;
  workspaceId?: string | null;
  /** Access floor for an identity-wide read when workspaceId is undefined. */
  allowedWorkspaceIds?: string[];
}): SQL[] {
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

  conditions.push(
    or(
      isNotNull(entityFacets.workspaceId),
      eq(entityFacets.userId, opts.userId)
    ) as SQL
  );

  return conditions;
}
