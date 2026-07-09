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
 * - lens `undefined` → no workspace filter (all lenses)
 * - lens `null`      → base-only (facets with no workspace)
 * - lens `string`    → that workspace's facets + pod-wide (null-workspace) ones
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
