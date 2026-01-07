/**
 * Workspace Permission Utilities
 * 
 * Helper functions for enforcing role-based access control in workspaces.
 * Shared across API and Jobs packages.
 * 
 * @module workspace-permissions
 */

import { eq, and } from 'drizzle-orm';
import { workspaceMembers, type WorkspaceMember } from '../schema/index.js';

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
export type WorkspaceRole = 'viewer' | 'editor' | 'admin' | 'owner';

/**
 * Custom error for permission failures
 */
export class PermissionError extends Error {
  code: string;
  
  constructor(code: 'NOT_FOUND' | 'FORBIDDEN', message: string) {
    super(message);
    this.code = code;
    this.name = 'PermissionError';
  }
}

/**
 * Require user to have minimum role in workspace
 * 
 * @param db - Database instance
 * @param workspaceId - Workspace UUID
 * @param userId - User ID (Kratos identity)
 * @param minimumRole - Minimum required role
 * @returns Workspace membership if allowed
 * @throws PermissionError NOT_FOUND if not a member
 * @throws PermissionError FORBIDDEN if role insufficient
 */
export async function requireWorkspaceRole(
  db: any,
  workspaceId: string,
  userId: string,
  minimumRole: WorkspaceRole
): Promise<WorkspaceMember> {
  // Find user's membership in workspace
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
  });
  
  // Not a member → workspace doesn't exist (or no access)
  if (!membership) {
    throw new PermissionError('NOT_FOUND', 'Workspace not found');
  }
  
  // Check role hierarchy
  const userLevel = ROLE_HIERARCHY[membership.role] || 0;
  const requiredLevel = ROLE_HIERARCHY[minimumRole];
  
  if (userLevel < requiredLevel) {
    throw new PermissionError(
      'FORBIDDEN',
      `Requires ${minimumRole} role or higher (you have: ${membership.role})`
    );
  }
  
  return membership;
}

/**
 * Require user to be a viewer (or higher) in workspace
 */
export async function requireViewer(
  db: any,
  workspaceId: string,
  userId: string
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(db, workspaceId, userId, 'viewer');
}

/**
 * Require user to be an editor (or higher) in workspace
 */
export async function requireEditor(
  db: any,
  workspaceId: string,
  userId: string
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(db, workspaceId, userId, 'editor');
}

/**
 * Require user to be an admin (or higher) in workspace
 */
export async function requireAdmin(
  db: any,
  workspaceId: string,
  userId: string
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(db, workspaceId, userId, 'admin');
}

/**
 * Require user to be the owner of workspace
 */
export async function requireOwner(
  db: any,
  workspaceId: string,
  userId: string
): Promise<WorkspaceMember> {
  return requireWorkspaceRole(db, workspaceId, userId, 'owner');
}

/**
 * Require user to own a personal resource (no workspace)
 */
export function requireResourceOwner(
  resource: { userId: string },
  userId: string
): void {
  if (resource.userId !== userId) {
    throw new PermissionError(
      'FORBIDDEN',
      'Only the resource owner can perform this action'
    );
  }
}

/**
 * Check if user has at least the specified role in workspace
 * Non-throwing version of requireWorkspaceRole.
 */
export async function hasWorkspaceRole(
  db: any,
  workspaceId: string,
  userId: string,
  minimumRole: WorkspaceRole
): Promise<boolean> {
  try {
    await requireWorkspaceRole(db, workspaceId, userId, minimumRole);
    return true;
  } catch {
    return false;
  }
}
