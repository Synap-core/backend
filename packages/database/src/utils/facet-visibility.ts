/**
 * Canonical visibility predicate for entity_facets reads — the ONE place the
 * workspace-lens + owner-floor semantics live. Used by both
 * FacetRepository.getByEntity/listByProfile and getEffectiveFacets so the
 * two read paths cannot drift.
 *
 * Semantics (mirrors the `workspaceOwned` VisibilityRule registered for
 * entityFacets in the API access registry):
 * - lens `undefined` → no workspace filter (all lenses)
 * - lens `null`      → base-only (facets with no workspace)
 * - lens `string`    → that workspace's facets + pod-wide (null-workspace) ones
 * - owner floor      → a pod-wide (null-workspace) facet is visible ONLY to
 *   its owner; workspace-scoped facets rely on the caller's already-verified
 *   workspace membership.
 */

import { type SQL, eq, isNotNull, isNull, or } from "drizzle-orm";
import { entityFacets } from "../schema/entity-facets.js";

export function facetVisibilityConditions(opts: {
  userId: string;
  workspaceId?: string | null;
}): SQL[] {
  const conditions: SQL[] = [];

  if (opts.workspaceId === null) {
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
