/**
 * POD-MEMBERSHIP predicate — the ONE door for "is the caller a member of this
 * pod?" as SQL (Membership → Visibility, Wave 2).
 *
 * It lives in `@synap/database` rather than `@synap/api` because THREE mirrors
 * need it and they must not drift:
 *   1. `accessScopeWhere` (packages/api utils/project-scope.ts) — the entity floor
 *   2. `facetVisibilityConditions` (utils/facet-visibility.ts, this package) +
 *      the `entityFacets` VisibilityRule (packages/api access/registry.ts)
 *   3. `entityQueryVisibilityWhere` (packages/jobs workers/entity-query-scope.ts)
 * `@synap/api` re-exports `podMemberWhere` from here; `@synap/jobs` imports it
 * directly (neither package may import the other).
 *
 * Emitted as `EXISTS (SELECT 1 FROM pod_members WHERE user_id = <userId>)`: a
 * membership FACT about the CALLER, bound to exactly the caller's own id and
 * independent of any row's columns. It is therefore only ever ANDed with a
 * row-shape predicate (e.g. `workspace_id IS NULL AND <shared-to-pod>`) — on its
 * own it would be a constant.
 */

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { podMembers } from "../schema/workspaces.js";

/**
 * SHARED-TO-POD, defined once: a facet row whose `workspace_id IS NULL` is
 * pod-wide, and pod-wide IS the share grant — the pod-level twin of "a facet in
 * workspace W is shared with W's members". There is no per-facet private flag
 * (see entity-facets.ts), so NULL-workspace is the only available signal. An
 * ENTITY is shared-to-pod when it is itself pod-wide AND carries such a facet;
 * an un-faceted pod-wide entity stays owner-private.
 */
export function podMemberWhere(userId: string): SQL {
  return drizzleSql`EXISTS (SELECT 1 FROM ${podMembers} WHERE ${podMembers.userId} = ${userId})`;
}
