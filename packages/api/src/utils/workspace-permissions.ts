/**
 * Workspace Permission Utilities
 *
 * Helper functions for enforcing role-based access control in workspaces.
 *
 * @module workspace-permissions
 * @see packages/api/src/lib/permissions.ts - Core permission logic
 * @see docs/brain/permission_roadmap.md - Future evolution plan
 */

import {
  eq,
  and,
  workspaceMembers,
  type WorkspaceMember,
} from "@synap/database";
import { TRPCError } from "@trpc/server";

/**
 * Role hierarchy for built-in workspace roles
 * Higher number = more permissions
 */
const ROLE_HIERARCHY: Record<string, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

/**
 * Type for workspace roles
 */
export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner";

/**
 * Require user to have minimum role in workspace
 *
 * @param db - Database instance
 * @param workspaceId - Workspace UUID
 * @param userId - User ID (Kratos identity)
 * @param minimumRole - Minimum required role
 * @returns Workspace membership if allowed
 * @throws TRPCError NOT_FOUND if not a member
 * @throws TRPCError FORBIDDEN if role insufficient
 *
 * @example
 * ```typescript
 * // Require user to be at least an editor
 * await requireWorkspaceRole(ctx.db, workspaceId, ctx.userId, 'editor');
 *
 * // This allows: editor, admin, owner
 * // This denies: viewer (throws FORBIDDEN)
 * // Non-members: throws NOT_FOUND
 * ```
 */
export async function requireWorkspaceRole(
  db: any,
  workspaceId: string,
  userId: string,
  minimumRole: WorkspaceRole,
): Promise<WorkspaceMember> {
  // Find user's membership in workspace
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId),
    ),
  });

  // Not a member → workspace doesn't exist (or no access)
  if (!membership) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Workspace not found",
    });
  }

  // Check role hierarchy
  const userLevel = ROLE_HIERARCHY[membership.role] || 0;
  const requiredLevel = ROLE_HIERARCHY[minimumRole];

  if (userLevel < requiredLevel) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Requires ${minimumRole} role or higher (you have: ${membership.role})`,
    });
  }

  return membership;
}

/**
 * Require user to be a viewer (or higher) in workspace
 *
 * @example
 * ```typescript
 * // Check user can read workspace resources
 * await requireViewer(ctx.db, workspaceId, ctx.userId);
 * ```
 */
export async function requireViewer(
  db: any,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(db, workspaceId, userId, "viewer");
}

/**
 * Require user to be an editor (or higher) in workspace
 *
 * Editors can create and modify most resources (views, documents, entities).
 *
 * @example
 * ```typescript
 * // Check user can edit view
 * await requireEditor(ctx.db, view.workspaceId, ctx.userId);
 * ```
 */
export async function requireEditor(
  db: any,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(db, workspaceId, userId, "editor");
}

/**
 * Require user to be an admin (or higher) in workspace
 *
 * Admins can manage workspace settings and members (except removal of owner).
 *
 * @example
 * ```typescript
 * // Check user can invite members
 * await requireAdmin(ctx.db, workspaceId, ctx.userId);
 * ```
 */
export async function requireAdmin(
  db: any,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(db, workspaceId, userId, "admin");
}

/**
 * Require user to be the owner of workspace
 *
 * Only owners can delete workspace or change critical settings.
 *
 * @example
 * ```typescript
 * // Check user can delete workspace
 * await requireOwner(ctx.db, workspaceId, ctx.userId);
 * ```
 */
export async function requireOwner(
  db: any,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(db, workspaceId, userId, "owner");
}

/**
 * Require user to own a personal resource (no workspace)
 *
 * For resources without a workspaceId, only the creator can access them.
 *
 * @param resource - Resource with userId field
 * @param userId - Current user ID
 * @throws TRPCError FORBIDDEN if not owner
 *
 * @example
 * ```typescript
 * // Personal view (no workspace)
 * if (!view.workspaceId) {
 *   requireResourceOwner(view, ctx.userId);
 * }
 * ```
 */
export function requireResourceOwner(
  resource: { userId: string },
  userId: string,
): void {
  if (resource.userId !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only the resource owner can perform this action",
    });
  }
}

/**
 * Check if user has at least the specified role in workspace
 *
 * Non-throwing version of requireWorkspaceRole.
 *
 * @returns true if user has sufficient role, false otherwise
 *
 * @example
 * ```typescript
 * const canEdit = await hasWorkspaceRole(ctx.db, workspaceId, ctx.userId, 'editor');
 * if (canEdit) {
 *   // Show edit button
 * }
 * ```
 */
export async function hasWorkspaceRole(
  db: any,
  workspaceId: string,
  userId: string,
  minimumRole: WorkspaceRole,
): Promise<boolean> {
  try {
    await requireWorkspaceRole(db, workspaceId, userId, minimumRole);
    return true;
  } catch {
    return false;
  }
}
