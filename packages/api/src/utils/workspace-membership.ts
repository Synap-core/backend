/**
 * Workspace Membership Utilities
 *
 * Helpers for cross-workspace queries: resolve which workspaces a user
 * belongs to, and silently filter a requested list to accessible IDs only.
 */

import { eq, inArray, and, or, memberWorkspaceIds } from "@synap/database";
import { workspaceMembers, workspaces } from "@synap/database/schema";
import { db } from "@synap/database";
import { podVisibleWorkspaceWhere } from "./user-visible-where.js";

/**
 * The workspaces `userId` may read — the SAME floor as `userVisibleWhere`:
 * MEMBER ∪ OWNED ∪ POD-VISIBLE. OWNED is its own branch: `workspaces.owner_id`
 * is first-class and a sovereign pod's owner may have no member row, so a
 * member-only floor hid their own private spaces (homes review G:
 * `profiles.listMulti` dropped them). Composed from the shared branch builders,
 * never re-derived.
 */
function readableWorkspaceWhere(userId: string) {
  return or(
    inArray(workspaces.id, memberWorkspaceIds(userId)),
    eq(workspaces.ownerId, userId),
    podVisibleWorkspaceWhere(userId)
  )!;
}

/**
 * Return all workspace IDs the user can read (member ∪ owned ∪ pod-visible).
 */
export async function getUserWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await db.query.workspaces.findMany({
    where: readableWorkspaceWhere(userId),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Given a list of requested workspace IDs, return only the ones the user
 * actually has access to (silent intersection — never throws).
 *
 * If `requested` is empty, returns all workspace IDs the user can read.
 */
export async function validateWorkspaceAccess(
  userId: string,
  requested?: string[]
): Promise<string[]> {
  if (!requested || requested.length === 0) {
    return getUserWorkspaceIds(userId);
  }
  const rows = await db.query.workspaces.findMany({
    where: and(
      inArray(workspaces.id, requested),
      readableWorkspaceWhere(userId)
    ),
    columns: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Resolve the canonical role/facet read scope for a user-facing API call.
 * Explicit workspace lenses are silently intersected with the caller's access;
 * no-lens reads receive the complete user floor. `null` deliberately means the
 * caller's pod-wide roles only.
 */
export async function resolveFacetVisibilityScope(
  userId: string,
  workspaceId?: string | null
): Promise<{
  userId: string;
  workspaceId?: string | null;
  allowedWorkspaceIds?: string[];
}> {
  if (workspaceId === null) return { userId, workspaceId: null };

  if (workspaceId !== undefined) {
    const allowedWorkspaceIds = await validateWorkspaceAccess(userId, [
      workspaceId,
    ]);
    return allowedWorkspaceIds.includes(workspaceId)
      ? { userId, workspaceId }
      : { userId, allowedWorkspaceIds: [] };
  }

  return {
    userId,
    allowedWorkspaceIds: await validateWorkspaceAccess(userId),
  };
}

/**
 * The caller's own workspace MEMBERSHIPS, with names — for actionable
 * "you are not a member of that workspace" errors.
 *
 * Strictly caller-scoped: one `workspaceMembers.userId = :userId` predicate,
 * so it can only ever return rows the caller is already a member of. Nothing
 * about other users' or other members' workspaces is observable through it.
 *
 * Deliberately NOT `getUserWorkspaceIds()` above: that helper additionally
 * folds in pod_visible/pod_joinable workspaces the caller is NOT a member of.
 * Those fail the membership check in `workspaceProcedure`/`podProcedure`, so
 * offering them as candidates would be actively misleading. Membership is
 * exactly the predicate the denial is about.
 */
export async function listMemberWorkspaces(
  userId: string
): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId));
}
