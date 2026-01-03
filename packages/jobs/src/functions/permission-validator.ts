/**
 * Permission Validator Worker
 * 
 * Phase 2: Implements the approval layer in the 3-phase event pattern
 * 
 * Flow:
 *  1. Listen to {table}.{action}.requested events
 *  2. Validate permissions (ownership, team access, etc.)
 *  3. Emit {table}.{action}.approved OR {table}.{action}.rejected
 * 
 * Auto-approval for direct user actions:
 *  - User creates their own entity → auto-approved
 *  - AI proposes entity → requires user approval (handled in UI)
 *  - User modifies own entity → auto-approved
 */

import { inngest } from '../client.js';
import { createLogger } from '@synap-core/core';
import { publishEvent } from '@synap/events';

const logger = createLogger({ module: 'permission-validator' });

// ============================================================================
// PERMISSION VALIDATOR
// ============================================================================

export const permissionValidator = inngest.createFunction(
  {
    id: 'permission-validator',
    name: 'Permission Validator',
    retries: 2,
  },
  [
    // Listen to all .requested events
    { event: 'entities.create.requested' },
    { event: 'entities.update.requested' },
    { event: 'entities.delete.requested' },
    { event: 'documents.create.requested' },
    { event: 'documents.update.requested' },
    { event: 'documents.delete.requested' },
    { event: 'workspaces.create.requested' },
    { event: 'workspaces.update.requested' },
    { event: 'views.create.requested' },
    { event: 'views.update.requested' },
    { event: 'views.delete.requested' },
  ],
  async ({ event, step }) => {
    const eventName = event.name as string;
    const [table, action] = eventName.split('.');
    const userId = event.user?.id;
    
    if (!userId) {
      logger.error({ eventName }, 'No userId in event - rejecting');
      return { approved: false, reason: 'No user context' };
    }
    
    logger.info({ eventName, userId }, 'Validating permissions');
    
    // ========================================================================
    // STEP 1: Check if this is an AI proposal
    // ========================================================================
    const isAIProposal = await step.run('check-ai-proposal', async () => {
      // Check metadata for AI proposal flag
      const metadata = (event.data as any)?.metadata || {};
      return metadata.source === 'ai-proposal' || metadata.proposedBy === 'ai';
    });
    
    if (isAIProposal) {
      logger.info({ eventName }, 'AI proposal detected - requires user approval');
      // AI proposals are handled in the UI - user must explicitly approve
      // This worker just validates permissions when user clicks "Approve"
      // For now, we don't auto-approve AI proposals
      return {
        approved: false,
        reason: 'AI proposal requires explicit user approval',
        pendingUserApproval: true,
      };
    }
    
    // ========================================================================
    // STEP 2: Validate ownership/permissions
    // ========================================================================
    const hasPermission = await step.run('validate-permission', async () => {
      const { getDb } = await import('@synap/database');
      const db = await getDb();
      
      // For CREATE: User can always create their own resources
      if (action === 'create') {
        logger.info({ userId, action }, 'Auto-approving CREATE for user');
        return true;
      }
      
      // For UPDATE/DELETE: Check ownership
      if (action === 'update' || action === 'delete') {
        const resourceId = (event.data as any).entityId || 
                          (event.data as any).documentId ||
                          (event.data as any).viewId ||
                          (event.data as any).workspaceId;
        
        if (!resourceId) {
          logger.error({ eventName }, 'No resource ID in event data');
          return false;
        }
        
        // Check ownership based on table type
        try {
          let isOwner = false;
          
          if (table === 'entities') {
            const { entities, eq } = await import('@synap/database');
            const [entity] = await db.select().from(entities)
              .where(eq(entities.id, resourceId))
              .limit(1);
            isOwner = entity?.userId === userId;
          } else if (table === 'documents') {
            const { documents, eq } = await import('@synap/database');
            const [doc] = await db.select().from(documents)
              .where(eq(documents.id, resourceId))
              .limit(1);
            isOwner = doc?.userId === userId;
          } else if (table === 'workspaces') {
            // Check workspace membership (simplified - should check roles)
            const { workspaceMembers, eq, and } = await import('@synap/database');
            const [member] = await db.select().from(workspaceMembers)
              .where(and(
                eq(workspaceMembers.workspaceId, resourceId),
                eq(workspaceMembers.userId, userId)
              ))
              .limit(1);
            isOwner = member !== undefined;
          } else if (table === 'views') {
            const { views, eq } = await import('@synap/database');
            const [view] = await db.select().from(views)
              .where(eq(views.id, resourceId))
              .limit(1);
            isOwner = view?.userId === userId;
          }
          
          logger.info({ table, resourceId, userId, isOwner }, 'Ownership check complete');
          return isOwner;
        } catch (error) {
          logger.error({ err: error, table, resourceId }, 'Permission check failed');
          return false;
        }
      }
      
      return false;
    });
    
    // ========================================================================
    // STEP 3: Emit approved/rejected event
    // ========================================================================
    if (hasPermission) {
      await step.run('emit-approved', async () => {
        const approvedEventType = eventName.replace('.requested', '.approved');
        
        await publishEvent({
          type: approvedEventType as any,
          subjectId: (event.data as any).id || (event.data as any).entityId || 'unknown',
          subjectType: table as any,
          data: event.data,
        }, {
          userId,
          metadata: {
            approvedBy: 'permission-validator',
            approvalReason: 'auto-approved',
            originalEvent: eventName,
          },
        });
        
        logger.info({ approvedEventType }, 'Permission approved - emitted .approved event');
      });
      
      return { approved: true, reason: 'Permission granted' };
    } else {
      logger.warn({ eventName, userId }, 'Permission denied');
      
      // TODO: Emit .rejected event for audit trail
      return { approved: false, reason: 'Permission denied' };
    }
  }
);
