/**
 * Permission System - Dynamic Multi-Level Access Control
 * 
 * Works for both workspaces AND projects with same code.
 * Implements 3-level permission checking:
 * 1. Membership check (is user in workspace/project?)
 * 2. Role-based permissions (what can this role do?)
 * 3. Resource-level checks (optional: specific resource access)
 */

// ============================================================================
// Types
// ============================================================================

export type UserRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type PermissionType = 'read' | 'write' | 'delete' | 'manage' | 'invite';
export type ContextType = 'workspace' | 'project';

export interface MembershipContext {
  type: ContextType;
  id: string; // workspaceId or projectId
  userId: string;
}

export interface PermissionCheckParams {
  db: any; // Database instance
  userId: string;
  workspace?: {
    id: string;
  };
  project?: {
    ids?: string[]; // Resource can be in multiple projects
  };
  requiredPermission: PermissionType;
}

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  role?: UserRole;
  context?: 'workspace' | 'project';
}

// ============================================================================
// Role Permission Matrix
// ============================================================================

const ROLE_PERMISSIONS: Record<UserRole, PermissionType[]> = {
  owner: ['read', 'write', 'delete', 'manage', 'invite'],
  admin: ['read', 'write', 'manage', 'invite'],  // Can manage but not delete
  editor: ['read', 'write'],
  viewer: ['read'],
};

/**
 * Check if a role has a specific permission
 */
export function hasRolePermission(
  role: UserRole,
  requiredPermission: PermissionType
): boolean {
  const allowedPermissions = ROLE_PERMISSIONS[role];
  return allowedPermissions.includes(requiredPermission);
}

// ============================================================================
// Dynamic Membership Check (Works for both Workspace & Project)
// ============================================================================

/**
 * Generic membership check - works for both workspaces and projects
 */
export async function getMembership(
  db: any,
  context: MembershipContext
): Promise<{ role: UserRole } | null> {
  
  if (context.type === 'workspace') {
    // Check workspace_members table
    const member = await db.query.workspaceMembers.findFirst({
      where: (members: any, { eq, and }: any) => and(
        eq(members.workspaceId, context.id),
        eq(members.userId, context.userId)
      ),
    });
    
    return member ? { role: member.role as UserRole } : null;
  } 
  
  if (context.type === 'project') {
    // Check project_members table
    const member = await db.query.projectMembers.findFirst({
      where: (members: any, { eq, and }: any) => and(
        eq(members.projectId, context.id),
        eq(members.userId, context.userId)
      ),
    });
    
    return member ? { role: member.role as UserRole } : null;
  }
  
  return null;
}

/**
 * Check workspace membership specifically
 */
export async function getWorkspaceMembership(
  db: any,
  workspaceId: string,
  userId: string
): Promise<{ role: UserRole } | null> {
  return getMembership(db, {
    type: 'workspace',
    id: workspaceId,
    userId,
  });
}

/**
 * Check project membership (for any of the given project IDs)
 */
export async function getProjectMembership(
  db: any,
  projectIds: string[],
  userId: string
): Promise<{ role: UserRole; projectId: string } | null> {
  if (!projectIds || projectIds.length === 0) {
    return null;
  }
  
  // Check if user is member of ANY of the projects
  const member = await db.query.projectMembers.findFirst({
    where: (members: any, { eq, and, inArray }: any) => and(
      inArray(members.projectId, projectIds),
      eq(members.userId, userId)
    ),
  });
  
  return member ? { role: member.role as UserRole, projectId: member.projectId } : null;
}

// ============================================================================
// Combined Permission Check (3-Level System)
// ============================================================================

/**
 * Check permissions with project-first hierarchy:
 * 
 * When projectId is provided:
 * 1. Check workspace membership (required for all)
 * 2. Check project membership and role (takes precedence)
 * 3. Workspace owners bypass project membership requirement
 * 
 * When no projectId:
 * 1. Check workspace membership
 * 2. Check workspace role permissions
 */
export async function verifyPermission(
  params: PermissionCheckParams
): Promise<PermissionResult> {
  
  const { db, userId, workspace, project, requiredPermission } = params;
  
  // ========================================================================
  // Level 1: Workspace Membership Check (ALWAYS REQUIRED)
  // ========================================================================
  
  if (!workspace?.id) {
    return { 
      allowed: false, 
      reason: "No workspace context provided" 
    };
  }
  
  const workspaceMember = await getWorkspaceMembership(
    db,
    workspace.id,
    userId
  );
  
  if (!workspaceMember) {
    return { 
      allowed: false, 
      reason: "User is not a member of this workspace",
      context: 'workspace'
    };
  }
  
  // ========================================================================
  // Level 2: Project-First Logic (when resource has projectId)
  // ========================================================================
  
  if (project?.ids && project.ids.length > 0) {
    const projectMember = await getProjectMembership(
      db,
      project.ids,
      userId
    );
    
    // User is a member of the project - use project role (takes precedence)
    if (projectMember) {
      const hasProjectPermission = hasRolePermission(
        projectMember.role,
        requiredPermission
      );
      
      if (hasProjectPermission) {
        return {
          allowed: true,
          role: projectMember.role,
          context: 'project'
        };
      } else {
        return {
          allowed: false,
          reason: `Insufficient project permissions (role: ${projectMember.role})`,
          role: projectMember.role,
          context: 'project'
        };
      }
    }
    
    // User is NOT a project member
    // Special case: Workspace owners can access all projects
    if (workspaceMember.role === 'owner') {
      const hasOwnerPermission = hasRolePermission(
        workspaceMember.role,
        requiredPermission
      );
      
      if (hasOwnerPermission) {
        return {
          allowed: true,
          role: workspaceMember.role,
          context: 'workspace'  // Owner bypass
        };
      }
    }
    
    // Not in project and not workspace owner
    return {
      allowed: false,
      reason: "User is not a member of any of the resource's projects",
      role: workspaceMember.role,
      context: 'project'
    };
  }
  
  // ========================================================================
  // Level 3: Workspace-Only (no project context)
  // ========================================================================
  
  const hasWorkspacePermission = hasRolePermission(
    workspaceMember.role,
    requiredPermission
  );
  
  if (!hasWorkspacePermission) {
    return {
      allowed: false,
      reason: `Insufficient workspace permissions (role: ${workspaceMember.role})`,
      role: workspaceMember.role,
      context: 'workspace'
    };
  }
  
  return {
    allowed: true,
    role: workspaceMember.role,
    context: 'workspace'
  };
}


// ============================================================================
// Convenience Wrappers (for backward compatibility with existing code)
// ============================================================================

/**
 * Check if user can perform write operations
 */
export async function canEdit(
  db: any,
  workspaceId: string,
  userId: string,
  projectIds?: string[]
): Promise<boolean> {
  const result = await verifyPermission({
    db,
    userId,
    workspace: { id: workspaceId },
    project: projectIds ? { ids: projectIds } : undefined,
    requiredPermission: 'write',
  });
  
  return result.allowed;
}

/**
 * Check if user can manage (owner-level)
 */
export async function canManage(
  db: any,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const result = await verifyPermission({
    db,
    userId,
    workspace: { id: workspaceId },
    requiredPermission: 'manage',
  });
  
  return result.allowed;
}

