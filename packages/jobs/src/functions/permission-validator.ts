/**
 * Permission Validator Worker - Streamlined Approach
 * 
 * Universal validator for all .requested events.
 * Reuses existing workspace-permissions helpers.
 * Updates event metadata instead of creating new tables.
 * 
 * Flow:
 *  1. Listen to *.*.requested (all requested events)
 *  2. Check permissions using workspace-permissions helpers
 *  3. Update event metadata with approval status
 *  4. Emit .validated, .pending, or .denied event
 */

import { inngest } from '../client.js';
import { createLogger } from '@synap-core/core';
import { 
  requireEditor, 
  requireOwner,
  requireViewer,
} from '@synap/database';


const logger = createLogger({ module: 'permission-validator' });

// ============================================================================
// PERMISSION VALIDATOR
// ============================================================================

export const permissionValidator = inngest.createFunction(
  {
    id: 'permission-validator',
    name: 'Universal Permission Validator',
    retries: 2,
  },
  // ✅ Listen to ALL .requested events (wildcard)
  { event: '*.*.requested' },
  async ({ event, step }) => {
    const eventName = event.name as string;
    const [resource, action] = eventName.split('.');
    const userId = event.user?.id || event.data.userId;
    const workspaceId = event.data.workspaceId;
    const source = event.data.source || 'user'; // 'user' | 'ai'
    
    if (!userId) {
      logger.error({ eventName }, 'No userId in event - auto-denying');
      await emitDenied(event, 'No user context');
      return { approved: false, reason: 'No user context' };
    }
    
    logger.info({ eventName, userId, action, resource, source }, 'Validating permissions');
    
    // ========================================================================
    // STEP 1: Check if AI proposal (requires user approval unless auto-enabled)
    // ========================================================================
    if (source === 'ai') {
      const workspace = await step.run('get-workspace-ai-settings', async () => {
        if (!workspaceId) return null;
        
        const { getDb, workspaces, eq } = await import('@synap/database');
        const db = await getDb();
        
        const [ws] = await db.select()
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        
        return ws;
      });
      
      const aiAutoApprove = (workspace?.settings as any)?.aiAutoApprove || false;
      
      if (!aiAutoApprove) {
        logger.info({ eventName }, 'AI proposal requires user approval');
        await emitPending(event, [userId], 'AI proposal requires user confirmation');
        return { approved: false, status: 'pending', reason: 'AI proposal' };
      }
      
      // AI auto-approve enabled - continue to permission checks
      logger.info({ eventName }, 'AI auto-approve enabled');
    }
    
    // ========================================================================
    // STEP 2: Validate permissions using existing helpers
    // ========================================================================
    const permissionResult = await step.run('validate-permission', async () => {
      try {
        const { getDb } = await import('@synap/database');
        const db = await getDb();
        
        // Personal resources (no workspace) - check ownership
        if (!workspaceId) {
          // For personal resources, user must be the creator
          // This is checked in table workers, auto-approve here
          return { granted: true, reason: 'personal-resource' };
        }
        
        // ✅ REUSE EXISTING HELPERS!
        
        // DELETE: Only owner can delete
        if (action === 'delete') {
          try {
            await requireOwner(db, workspaceId, userId);
            return { granted: true, reason: 'owner-delete' };
          } catch (error) {
            // Not owner - needs approval
            const { workspaces, eq } = await import('@synap/database');
            const [ws] = await db.select()
              .from(workspaces)
              .where(eq(workspaces.id, workspaceId))
              .limit(1);
            
            return { 
              granted: false, 
              needsApproval: true,
              approvers: ws ? [ws.ownerId] : [],
              reason: 'Only workspace owner can delete resources'
            };
          }
        }
        
        // CREATE/UPDATE: Editor+ can modify
        if (action === 'create' || action === 'update') {
          try {
            await requireEditor(db, workspaceId, userId);
            return { granted: true, reason: 'editor-modify' };
          } catch (error) {
            // Not editor - denied (viewers can't create/edit)
            return { 
              granted: false, 
              needsApproval: false,
              reason: (error as Error).message || 'Viewers cannot create or edit resources'
            };
          }
        }
        
        // READ: Viewer+ can read
        if (action === 'read' || action === 'list') {
          try {
            await requireViewer(db, workspaceId, userId);
            return { granted: true, reason: 'viewer-read' };
          } catch (error) {
            return { 
              granted: false, 
              needsApproval: false,
              reason: 'Not a workspace member'
            };
          }
        }
        
        // Unknown action - deny
        return { 
          granted: false, 
          needsApproval: false,
          reason: `Unknown action: ${action}`
        };
        
      } catch (error) {
        logger.error({ err: error, eventName }, 'Permission check failed');
        return { 
          granted: false, 
          needsApproval: false,
          reason: 'Permission check error'
        };
      }
    });
    
    // ========================================================================
    // STEP 3: Handle permission result
    // ========================================================================
    if (permissionResult.granted) {
      // AUTO-APPROVE
      await step.run('emit-validated', async () => {
        await updateEventMetadata(event.id!, {
          approvalStatus: 'approved',
          approvedBy: userId,
          approvedAt: new Date().toISOString(),
          approvalReason: permissionResult.reason,
          autoApproved: true,
        });
        
        await inngest.send({
          name: eventName.replace('.requested', '.validated'),
          data: event.data,
          user: event.user,
        });
        
        logger.info({ eventName, reason: permissionResult.reason }, 'Auto-approved');
      });
      
      return { approved: true, reason: permissionResult.reason };
    }
    
    if ('needsApproval' in permissionResult && permissionResult.needsApproval) {
      // NEEDS APPROVAL
      const approvers = 'approvers' in permissionResult ? permissionResult.approvers : [];
      await emitPending(event, approvers, permissionResult.reason as string);
      return { approved: false, status: 'pending', reason: permissionResult.reason as string };
    }
    
    // DENIED
    await emitDenied(event, permissionResult.reason as string);
    return { approved: false, status: 'denied', reason: permissionResult.reason as string };
  }
);

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

async function updateEventMetadata(eventId: string, metadata: Record<string, any>) {
  const { getDb, events, eq } = await import('@synap/database');
  const db = await getDb();
  
  // Update event metadata (merge with existing)
  const [currentEvent] = await db.select()
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  
  await db.update(events)
    .set({
      metadata: {
        ...(currentEvent.metadata || {}),
        ...metadata,
      }
    })
    .where(eq(events.id, eventId));
}

async function emitPending(event: any, approvers: string[], reason: string) {
  await updateEventMetadata(event.id, {
    approvalStatus: 'pending',
    approvers,
    pendingReason: reason,
    requestedAt: new Date().toISOString(),
  });
  
  logger.info({ eventName: event.name, approvers }, 'Approval pending');
}

async function emitDenied(event: any, reason: string) {
  await updateEventMetadata(event.id, {
    approvalStatus: 'denied',
    deniedReason: reason,
    deniedAt: new Date().toISOString(),
  });
  
  await inngest.send({
    name: event.name.replace('.requested', '.denied'),
    data: {
      ...event.data,
      denialReason: reason,
    },
    user: event.user,
  });
  
  logger.warn({ eventName: event.name, reason }, 'Permission denied');
}
