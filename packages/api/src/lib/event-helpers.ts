/**
 * Event Helper Library
 * 
 * Provides type-safe event logging functions for all domain events.
 * Follows the requested→validated pattern for all mutations.
 */

import { db } from '@synap/database';
import { events } from '@synap/database/schema';

/**
 * Base event logging function
 */
export async function logEvent(
  userId: string,
  type: string,
  data: Record<string, any>,
  options?: {
    subjectId?: string;
    subjectType?: string;
    metadata?: Record<string, any>;
    source?: string;
  }
): Promise<void> {
  await db.insert(events).values({
    userId,
    type,
    data,
    subjectId: options?.subjectId || 'unknown',
    subjectType: options?.subjectType || 'unknown',
    metadata: options?.metadata || {},
    source: options?.source || 'api',
    timestamp: new Date(),
  });
  
  console.log(`[Event] ${type}`, { userId, subjectId: options?.subjectId });
}

// ============================================================================
// WORKSPACE EVENTS
// ============================================================================

export const WorkspaceEvents = {
  createRequested: (userId: string, data: { name: string; type: string; description?: string }) =>
    logEvent(userId, 'workspaces.create.requested', data, {
      subjectType: 'workspace',
    }),
    
  createValidated: (userId: string, workspace: { id: string; name: string; type: string; ownerId: string }) =>
    logEvent(userId, 'workspaces.create.validated', workspace, {
      subjectId: workspace.id,
      subjectType: 'workspace',
    }),
    
  updateRequested: (userId: string, workspaceId: string, updates: Record<string, any>) =>
    logEvent(userId, 'workspaces.update.requested', { updates }, {
      subjectId: workspaceId,
      subjectType: 'workspace',
    }),
    
  updateValidated: (userId: string, workspaceId: string, changes: Record<string, any>) =>
    logEvent(userId, 'workspaces.update.validated', { id: workspaceId, changes }, {
      subjectId: workspaceId,
      subjectType: 'workspace',
    }),
    
  deleteRequested: (userId: string, workspaceId: string) =>
    logEvent(userId, 'workspaces.delete.requested', { id: workspaceId }, {
      subjectId: workspaceId,
      subjectType: 'workspace',
    }),
    
  deleteValidated: (userId: string, workspaceId: string) =>
    logEvent(userId, 'workspaces.delete.validated', { id: workspaceId }, {
      subjectId: workspaceId,
      subjectType: 'workspace',
    }),
};

export const WorkspaceMemberEvents = {
  inviteRequested: (userId: string, data: { workspaceId: string; email: string; role: string }) =>
    logEvent(userId, 'workspaceMembers.create.requested', data, {
      subjectId: data.workspaceId,
      subjectType: 'workspace_member',
    }),
    
  inviteValidated: (userId: string, member: { id: string; workspaceId: string; userId: string; role: string }) =>
    logEvent(userId, 'workspaceMembers.create.validated', member, {
      subjectId: member.id,
      subjectType: 'workspace_member',
    }),
    
  removeRequested: (userId: string, workspaceId: string, memberId: string) =>
    logEvent(userId, 'workspaceMembers.delete.requested', { workspaceId, memberId }, {
      subjectId: memberId,
      subjectType: 'workspace_member',
    }),
    
  removeValidated: (userId: string, memberId: string) =>
    logEvent(userId, 'workspaceMembers.delete.validated', { id: memberId }, {
      subjectId: memberId,
      subjectType: 'workspace_member',
    }),
};

// ============================================================================
// VIEW EVENTS
// ============================================================================

export const ViewEvents = {
  createRequested: (userId: string, data: { type: string; name: string; workspaceId: string }) =>
    logEvent(userId, 'views.create.requested', data, {
      subjectType: 'view',
    }),
    
  createValidated: (userId: string, view: { id: string; type: string; name: string; documentId: string }) =>
    logEvent(userId, 'views.create.validated', view, {
      subjectId: view.id,
      subjectType: 'view',
    }),
    
  updateRequested: (userId: string, viewId: string, saveType: 'manual' | 'publish') =>
    logEvent(userId, 'views.update.requested', { saveType }, {
      subjectId: viewId,
      subjectType: 'view',
    }),
    
  updateValidated: (userId: string, viewId: string, versionNumber: number) =>
    logEvent(userId, 'views.update.validated', {
      id: viewId,
      versionNumber,
      savedAt: new Date(),
    }, {
      subjectId: viewId,
      subjectType: 'view',
    }),
    
  deleteRequested: (userId: string, viewId: string) =>
    logEvent(userId, 'views.delete.requested', { id: viewId }, {
      subjectId: viewId,
      subjectType: 'view',
    }),
    
  deleteValidated: (userId: string, viewId: string) =>
    logEvent(userId, 'views.delete.validated', { id: viewId }, {
      subjectId: viewId,
      subjectType: 'view',
    }),
};

// ============================================================================
// USER PREFERENCES EVENTS
// ============================================================================

export const UserPreferencesEvents = {
  updateRequested: (userId: string, changes: Record<string, any>) =>
    logEvent(userId, 'userPreferences.update.requested', { changes }, {
      subjectId: userId,
      subjectType: 'user_preferences',
    }),
    
  updateValidated: (userId: string, changes: Record<string, any>) =>
    logEvent(userId, 'userPreferences.update.validated', { userId, changes }, {
      subjectId: userId,
      subjectType: 'user_preferences',
    }),
};
