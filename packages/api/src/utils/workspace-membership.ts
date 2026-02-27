/**
 * Workspace Membership Utilities
 *
 * Helpers for cross-workspace queries: resolve which workspaces a user
 * belongs to, and silently filter a requested list to accessible IDs only.
 */

import { eq, inArray } from "@synap/database";
import { workspaceMembers } from "@synap/database/schema";
import { db } from "@synap/database";

/**
 * Return all workspace IDs the user is a member of.
 */
export async function getUserWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.userId, userId),
    columns: { workspaceId: true },
  });
  return rows.map((r) => r.workspaceId);
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

  return rows.filter((r) => r.userId === userId).map((r) => r.workspaceId);
}
