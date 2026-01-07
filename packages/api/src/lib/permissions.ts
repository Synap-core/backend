/**
 * Permission System - Check if user can perform action
 * 
 * Validates permissions through:
 * 1. RBAC - Role-based access control
 * 2. ABAC - Attribute-based filtering (optional)
 * 3. ReBAC - Relationship-based sharing (optional)
 */

import { db, eq, and } from '@synap/database';
import { workspaceMembers } from '@synap/database/schema';

/**
 * Simple nested property accessor (replaces lodash.get)
 */
function getNestedProperty(obj: any, path: string): any {
  return path.split('.').reduce((current, prop) => current?.[prop], obj);
}

interface PermissionCheck {
  userId: string;
  action: 'create' | 'read' | 'update' | 'delete';
  resourceType: 'entity' | 'view' | 'workspace' | 'relation';
  workspaceId?: string;
  resourceData?: any; // For ABAC filtering
}

interface PermissionResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Check if user has permission to perform action
 * 
 * @example
 * const result = await checkPermission({
 *   userId: 'user-123',
 *   action: 'create',
 *   resourceType: 'entity',
 *   workspaceId: 'ws-456',
 *   resourceData: { type: 'task', metadata: { category: 'dev' } }
 * });
 */
export async function checkPermission(input: PermissionCheck): Promise<PermissionResult> {
  const { userId, action, resourceType, workspaceId } = input;
  
  // Personal resource (no workspace) - user owns it
  if (!workspaceId) {
    return { allowed: true };
  }
  
  // 1. Get user's membership in workspace
  const member = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
  });
  
  if (!member) {
    return { allowed: false, reason: 'Not a workspace member' };
  }
  
  // 2. Check role permissions (RBAC)
  // For now, use simple string role until roles table is created
  const rolePermissions = getRolePermissions(member.role);
  
  if (!rolePermissions[resourceType]?.[action]) {
    return { 
      allowed: false, 
      reason: `Role '${member.role}' lacks ${action} permission for ${resourceType}` 
    };
  }
  
  // 3. Apply filters (ABAC) - if role has filters
  // TODO: Implement when roles table with filters is created
  // if (member.role?.filters && resourceData) {
  //   const matches = matchesFilters(resourceData, member.role.filters);
  //   if (!matches) {
  //     return { allowed: false, reason: 'Filtered by role conditions' };
  //   }
  // }
  
  return { allowed: true };
}

/**
 * Get permissions for built-in roles
 * TODO: Replace with database query once roles table exists
 */
function getRolePermissions(role: string): Record<string, Record<string, boolean>> {
  const ROLE_PERMISSIONS = {
    owner: {
      workspaces: { create: true, read: true, update: true, delete: true },
      views: { create: true, read: true, update: true, delete: true },
      entities: { create: true, read: true, update: true, delete: true },
      relations: { create: true, read: true, update: true, delete: true },
    },
    admin: {
      workspaces: { read: true, update: true },
      views: { create: true, read: true, update: true, delete: true },
      entities: { create: true, read: true, update: true, delete: true },
      relations: { create: true, read: true, update: true, delete: true },
    },
    editor: {
      workspaces: { read: true },
      views: { create: true, read: true, update: true },
      entities: { create: true, read: true, update: true },
      relations: { create: true, read: true, update: true },
    },
    viewer: {
      workspaces: { read: true },
      views: { read: true },
      entities: { read: true },
      relations: { read: true },
    },
  };
  
  return ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] || ROLE_PERMISSIONS.viewer;
}

/**
 * Match resource data against filters (ABAC)
 * 
 * @example
 * matchesFilters(
 *   { type: 'task', metadata: { category: 'dev' } },
 *   { 'type': ['task'], 'metadata.category': ['dev', 'engineering'] }
 * ) === true
 */
export function matchesFilters(data: any, filters: Record<string, any>): boolean {
  for (const [path, allowedValues] of Object.entries(filters)) {
    const value = getNestedProperty(data, path);
    
    if (Array.isArray(allowedValues)) {
      // IN clause - value must be in allowed list
      if (!allowedValues.includes(value)) {
        return false;
      }
    } else if (typeof allowedValues === 'object') {
      // Complex conditions
      if (allowedValues.not && allowedValues.not.includes(value)) {
        return false;
      }
      if (allowedValues.contains && !value?.includes(allowedValues.contains)) {
        return false;
      }
    } else {
      // Exact match
      if (value !== allowedValues) {
        return false;
      }
    }
  }
  
  return true;
}

