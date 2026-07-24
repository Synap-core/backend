import { and, or, eq, isNull, entities } from "@synap/database";
import type { SQL } from "drizzle-orm";

/**
 * Visibility WHERE for an automation `query` node — the workspace-lens union:
 * this workspace's rows ∪ pod-wide (workspace_id NULL) rows, with the pod-wide
 * rows OWNER-floored so a run never surfaces another user's private pod-wide
 * entity.
 *
 * WHY this exists as a local predicate: this is the @synap/jobs-local MIRROR of
 * the canonical DATA-table resolver `accessScopeWhere`
 * (packages/api/src/utils/project-scope.ts — the SSOT). It is exactly
 * `accessScopeWhere({ workspaceLens: workspaceId, includeGlobalsInLens: true })`
 * reduced to its two profile-relevant FLOOR branches (podPersonal + the
 * workspace branch); the exposure/facet lens branches are intentionally omitted
 * — a `query` node is a direct profile enumeration, not an anchor-scoped read,
 * and pulling those in would WIDEN visibility beyond the requested profile.
 * `@synap/jobs` cannot import `@synap/api` (circular dep — see
 * utils/proactive-post.ts), so the predicate is duplicated here; keep it in
 * lockstep with the SSOT.
 *
 *   - `podPersonal` = `workspace_id IS NULL AND user_id = ownerId` — mirrors
 *     accessScopeWhere's `podPersonal` branch exactly (owner floor on the NULL
 *     rows). Pod-scoped kinds (company/person/bookmark…) live at
 *     `workspace_id IS NULL` (workspace-resolution-service K1: entityScope
 *     "pod" → null), so WITHOUT this branch a `query {profileSlug:'company'}`
 *     node returned ZERO rows — the bug that made every per-client daily loop
 *     fan out over nothing.
 *   - workspace branch = `workspace_id = workspaceId` — this workspace's shared
 *     rows (the run is already authorized for this workspace lens; not
 *     owner-floored, exactly like accessScopeWhere's workspace floor branch).
 *
 * SECURITY: the result matches ONLY (a) this workspace's rows and (b) pod-wide
 * rows owned by `ownerId`. It can never match another workspace's rows (their
 * `workspace_id` is a different non-null id) nor another user's pod-wide rows
 * (the owner floor). Workspace-scoped kinds (deal/grant_submission…) always
 * carry a non-null `workspace_id`, so the pod branch matches none of them → the
 * union is a strict no-op for them (no cross-scope widening).
 *
 * `podOnly` (a `scope:"pod"` node) drops the workspace branch → ONLY pod-wide
 * owner-floored rows.
 *
 * When `ownerId` is unknown the pod-wide branch is dropped (fail closed to this
 * workspace's own rows) — a NULL-workspace read with no owner floor would leak
 * every user's private pod-wide entities.
 */
export function entityQueryVisibilityWhere(args: {
  workspaceId: string;
  ownerId?: string;
  podOnly?: boolean;
}): SQL {
  const { workspaceId, ownerId, podOnly = false } = args;

  const podWide =
    ownerId !== undefined
      ? and(isNull(entities.workspaceId), eq(entities.userId, ownerId))
      : undefined;
  const workspaceOwn = eq(entities.workspaceId, workspaceId);

  if (podOnly) {
    // Owner-gate the pod-wide rows so this never returns another user's private
    // pod-wide entities. Fail closed when the owner is unknown.
    if (!podWide) {
      throw new Error("query node: scope 'pod' requires an owner");
    }
    return podWide;
  }

  // Default = the workspace-lens union. Fail closed to workspace-only when the
  // owner is unknown (never emit an un-floored NULL-workspace read).
  return podWide ? or(workspaceOwn, podWide)! : workspaceOwn;
}
