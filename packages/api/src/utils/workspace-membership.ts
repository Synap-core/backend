/**
 * Workspace Membership Utilities
 *
 * Helpers for cross-workspace queries: resolve which workspaces a user
 * belongs to, and silently filter a requested list to accessible IDs only.
 */

import { eq, inArray, and, drizzleSql } from "@synap/database";
import { workspaceMembers, workspaces } from "@synap/database/schema";
import { db } from "@synap/database";

/**
 * Return all workspace IDs the user is a member of.
 */
export async function getUserWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.userId, userId),
    columns: { workspaceId: true },
  });
  const ids = new Set(rows.map((r) => r.workspaceId));

  const podReadable = await db.query.workspaces.findMany({
    where: drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`,
    columns: { id: true },
  });
  for (const workspace of podReadable) ids.add(workspace.id);

  return Array.from(ids);
}

/**
 * Given a list of requested workspace IDs, return only the ones the user
 * actually has access to (silent intersection — never throws).
 *
 * If `requested` is empty, returns all workspace IDs the user belongs to.
 */
export async function validateWorkspaceAccess(
  userId: string,
  requested?: string[]
): Promise<string[]> {
  if (!requested || requested.length === 0) {
    return getUserWorkspaceIds(userId);
  }

  const rows = await db.query.workspaceMembers.findMany({
    where: inArray(workspaceMembers.workspaceId, requested),
    columns: { workspaceId: true, userId: true },
  });

  const ids = new Set(
    rows.filter((r) => r.userId === userId).map((r) => r.workspaceId)
  );

  const podReadable = await db.query.workspaces.findMany({
    where: and(
      inArray(workspaces.id, requested),
      drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`
    ),
    columns: { id: true },
  });
  for (const workspace of podReadable) ids.add(workspace.id);

  return Array.from(ids);
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
