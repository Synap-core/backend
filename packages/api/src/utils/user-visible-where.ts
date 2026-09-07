/**
 * `userVisibleWhere` — single source of truth for "what workspaces can this
 * user see" in pod↔outside boundary procedures.
 *
 * The IMPLEMENTATION of `userVisibleWhere` / `workspaceLensWhere` moved to
 * `@synap/database` (utils/user-visible-where.ts) — the same reason
 * `podMemberWhere` did: `@synap/api` depends on `@synap/jobs`
 * (api/package.json: `"@synap/jobs": "workspace:*"`), so `@synap/jobs` can never
 * import `@synap/api`, and the automation executor's non-entity read nodes
 * (`runs_query`, `proposals_query`) must apply EXACTLY the predicate the api
 * listings apply (`listAutomationRuns`, `proposals.list`) or a generated report
 * and the browser would tell different stories. `@synap/database` is the one
 * package both already depend on. This file OWNS NOTHING: it keeps the api-side
 * names so every existing import is unchanged.
 *
 * `ownerPrivateVisibleWhere` moved down for the same reason and the same proof —
 * its old "api-only, no non-api consumer today" note was false: two files inside
 * `@synap/database` (`services/team-person-bridge.ts`,
 * `utils/entity-project-membership.ts`) hand-inlined the identical predicate
 * because they cannot import upward. They now call the moved helper.
 *
 * Background and the ONE-DOOR (`.list` / no `.listAll`) contract: see the header
 * of the implementation file in `@synap/database`.
 */

export { userVisibleWhere, workspaceLensWhere } from "@synap/database";
export type { WorkspaceLens } from "@synap/database";

/**
 * Pod-membership predicate — TRUE for a query when `userId` has a row in
 * `pod_members` (the durable pod-membership identity, keyed on user_id since the
 * pod is a singleton deployment). Emitted as a correlated-safe
 * `EXISTS (SELECT 1 FROM pod_members WHERE user_id = <userId>)`, so it is a
 * membership FACT about the caller, independent of any row's columns.
 *
 * LIVE (Membership → Visibility, Wave 2). Consumers: the `podShared` floor branch
 * in `accessScopeWhere` (utils/project-scope.ts) and the `entityFacets`
 * VisibilityRule (access/registry.ts). The IMPLEMENTATION moved to
 * `@synap/database` (utils/pod-membership.ts) because `@synap/jobs` and
 * `@synap/database` itself need the identical predicate and neither may import
 * `@synap/api`; this stays as the api-side name so existing imports are unchanged.
 */
export { podMemberWhere } from "@synap/database";

/**
 * OWNER-PRIVATE floor for tables that have BOTH a `workspace_id` and a per-user
 * owner column, where a NULL workspace means "personal to the owner" — the
 * `ownerPrivate` shape in the access registry (focus_sessions, entities,
 * documents, …). Plain `userVisibleWhere` admits EVERY NULL-workspace row to ALL
 * users (its `isNull(workspaceId)` branch is owner-blind), so on such a table it
 * leaks another user's private sessions/rows. This gates the NULL branch by
 * owner and keeps the workspace-scoped branch on the shared user floor.
 *
 * For the entity graph prefer `accessScopeWhere` (it also carries exposure +
 * role-lens); this is the minimal owner-gate for hand-built join queries over
 * ownerPrivate tables that are NOT part of the entity-facet substrate.
 *
 * The IMPLEMENTATION moved to `@synap/database` (utils/user-visible-where.ts),
 * beside `userVisibleWhere` whose owner-blind NULL branch it exists to gate;
 * this stays as the api-side name so existing imports are unchanged.
 */
export { ownerPrivateVisibleWhere } from "@synap/database";
