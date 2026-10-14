/**
 * The entity READ floors — moved verbatim out of `routers/entities/helpers.ts`
 * (which re-exports them) so a service (`services/lifecycle/*`) reads the same
 * floor without importing a router module.
 */
import { entities } from "@synap/database/schema";
import { accessScopeWhere } from "../utils/project-scope.js";

// READ variant of the entity floor — the SAME resolver as `entityWriteVisibleWhere`
// (`routers/entities/helpers.ts`) PLUS the
// role-as-lens branch (a pod-wide entity is visible when it carries a facet in a
// workspace the caller is a member of). Used ONLY on READ paths (get/list/search/
// context); the mutation & dedup EXISTENCE gates keep `entityWriteVisibleWhere` (no
// facetLens) so that widening what a member can SEE never widens what they can
// TARGET for a write — write-targetability stays exactly as before.
export function entityReadVisibleWhere(userId: string) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    facetLens: true,
  });
}

// The read floor UNDER a workspace/pod lens. Routed through the one door so the
// 3-state lens + `includePodWide` union AND the role-as-lens widening are all
// expressed by `accessScopeWhere` params (never a hand-rolled predicate):
//   lens undefined → user-wide floor (+ role-lens)
//   lens null      → pod-personal only (owner-gated; role-lens AND-ed out)
//   lens "<id>"    → that workspace + entities role-attached there
//                    (+ pod-wide globals when includePodWide)
export function entityLensWhere(
  userId: string,
  lens?: string | null,
  opts?: { includePodWide?: boolean }
) {
  return accessScopeWhere({
    workspaceIdColumn: entities.workspaceId,
    entityIdColumn: entities.id,
    ownerColumn: entities.userId,
    userId,
    workspaceLens: lens,
    facetLens: true,
    includeGlobalsInLens: opts?.includePodWide ?? false,
  });
}
