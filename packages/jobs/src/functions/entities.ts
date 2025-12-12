/**
 * Entities Worker - Generic Entity Handler
 * 
 * Handles ALL entity types through a single worker:
 * - entities.create.requested
 * - entities.update.requested
 * - entities.delete.requested
 * 
 * Replaces: note-creation.ts, task-creation.ts, project-creation.ts
 */

import { inngest } from '../client.js';
import { storage } from '@synap/storage';
import { entities, taskDetails } from '@synap/database';
import { createLogger } from '@synap/core';
import { randomUUID, createHash } from 'crypto';
import type { EntityType } from '@synap/events';

const logger = createLogger({ module: 'entities-worker' });

// ============================================================================
// TYPES
// ============================================================================

interface EntitiesCreateRequestedData {
  entityType: EntityType;
  id?: string;
  title?: string;
  preview?: string;
  content?: string;
  file?: {
    content: string;
    filename: string;
    contentType: string;
    source: 'text-input' | 'file-upload' | 'ai-generated';
  };
  metadata?: Record<string, unknown>;
  requestId?: string;
}

interface EntitiesUpdateRequestedData {
  entityId: string;
  title?: string;
  preview?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

// ============================================================================
// WORKER
// ============================================================================

export const entitiesWorker = inngest.createFunction(
  {
    id: 'entities-handler',
    name: 'Entities Handler',
    retries: 3,
  },
  [
    { event: 'entities.create.requested' },
    { event: 'entities.update.requested' },
    { event: 'entities.delete.requested' },
  ],
  async ({ event, step }) => {
    const eventName = event.name as string;
    const action = eventName.split('.')[1] as 'create' | 'update' | 'delete';
    const userId = event.user?.id as string;
    
    if (!userId) {
      throw new Error('userId is required for entities operations');
    }
    
    logger.info({ eventName, action, userId }, 'Processing entities event');
    
    // ========================================================================
    // CREATE
    // ========================================================================
    if (action === 'create') {
      const data = event.data as EntitiesCreateRequestedData;
      const entityId = data.id || randomUUID();
      
      // Step 1: Handle file content (if present)
      let fileInfo: { 
        url: string; 
        path: string; 
        size: number; 
        checksum: string;
        type: string;
      } | null = null;
      
      if (data.content || data.file) {
        fileInfo = await step.run('upload-file', async () => {
          const content = data.file?.content || data.content || '';
          const isBase64 = data.file?.source === 'file-upload';
          const buffer = isBase64 
            ? Buffer.from(content, 'base64')
            : Buffer.from(content, 'utf-8');
          
          const ext = data.file?.filename?.split('.').pop() || 'md';
          const storagePath = `entities/${userId}/${data.entityType}s/${entityId}.${ext}`;
          
          const result = await storage.upload(storagePath, buffer, {
            contentType: data.file?.contentType || 'text/markdown',
          });
          
          const checksum = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
          
          logger.debug({ storagePath, size: buffer.length }, 'Uploaded entity file');
          
          return {
            url: result.url,
            path: result.path,
            size: buffer.length,
            checksum,
            type: ext === 'md' ? 'markdown' : ext,
          };
        });
      }
      
      // Step 2: Insert entity into database
      await step.run('insert-entity', async () => {
        const { getDb } = await import('@synap/database');
        const db = await getDb();
        
        const entityTitle = data.title || 
          (data.content?.split('\n')[0]?.slice(0, 100)) || 
          `Untitled ${data.entityType}`;
        const entityPreview = data.preview || data.content?.slice(0, 500);
        
        await db.insert(entities).values({
          id: entityId,
          userId,
          type: data.entityType,
          title: entityTitle,
          preview: entityPreview,
          fileUrl: fileInfo?.url,
          filePath: fileInfo?.path,
          fileSize: fileInfo?.size,
          fileType: fileInfo?.type,
          checksum: fileInfo?.checksum,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);
        
        logger.debug({ entityId, type: data.entityType }, 'Inserted entity');
      });
      
      // Step 3: Handle type-specific extensions
      if (data.entityType === 'task' && data.metadata) {
        await step.run('insert-task-details', async () => {
          const { getDb } = await import('@synap/database');
          const db = await getDb();
          
          await db.insert(taskDetails).values({
            taskId: entityId,
            priority: (data.metadata?.priority as number) ?? 0,
            dueDate: data.metadata?.dueDate 
              ? new Date(data.metadata.dueDate as string) 
              : null,
            tagNames: (data.metadata?.tags as string[]) ?? [],
          } as any);
          
          logger.debug({ entityId }, 'Inserted task details');
        });
      }
      
      // Step 4: Emit completion event
      await step.run('emit-completion', async () => {
        await inngest.send({
          name: 'entities.create.completed',
          data: {
            entityId,
            entityType: data.entityType,
            title: data.title,
            fileUrl: fileInfo?.url,
            filePath: fileInfo?.path,
            fileSize: fileInfo?.size,
            fileType: fileInfo?.type,
            checksum: fileInfo?.checksum,
          },
          user: { id: userId },
        });
        
        logger.info({ entityId }, 'Published entities.create.completed');
      });
      
      // Step 5: Broadcast to SSE clients
      await step.run('broadcast-notification', async () => {
        const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
        await broadcastNotification({
          userId,
          requestId: data.requestId,
          message: {
            type: 'entities.create.completed',
            data: {
              entityId,
              entityType: data.entityType,
              title: data.title,
            },
            requestId: data.requestId,
            status: 'success',
            timestamp: new Date().toISOString(),
          },
        });
      });
      
      return {
        success: true,
        action: 'create',
        entityId,
        entityType: data.entityType,
      };
    }
    
    // ========================================================================
    // UPDATE
    // ========================================================================
    if (action === 'update') {
      const data = event.data as EntitiesUpdateRequestedData;
      
      await step.run('update-entity', async () => {
        const { getDb, entities: entitiesTable, eq, and } = await import('@synap/database');
        const db = await getDb();
        
        await db.update(entitiesTable)
          .set({
            title: data.title,
            preview: data.preview,
            updatedAt: new Date(),
          } as any)
          .where(and(
            eq(entitiesTable.id, data.entityId),
            eq(entitiesTable.userId, userId),
          ));
        
        logger.info({ entityId: data.entityId }, 'Updated entity');
      });
      
      // TODO: Handle content update with file storage
      
      await step.run('emit-update-completion', async () => {
        await inngest.send({
          name: 'entities.update.completed',
          data: {
            entityId: data.entityId,
            title: data.title,
          },
          user: { id: userId },
        });
      });
      
      return {
        success: true,
        action: 'update',
        entityId: data.entityId,
      };
    }
    
    // ========================================================================
    // DELETE
    // ========================================================================
    if (action === 'delete') {
      const { entityId } = event.data as { entityId: string };
      
      await step.run('soft-delete-entity', async () => {
        const { getDb, entities: entitiesTable, eq, and } = await import('@synap/database');
        const db = await getDb();
        
        await db.update(entitiesTable)
          .set({
            deletedAt: new Date(),
          } as any)
          .where(and(
            eq(entitiesTable.id, entityId),
            eq(entitiesTable.userId, userId),
          ));
        
        logger.info({ entityId }, 'Soft-deleted entity');
      });
      
      await step.run('emit-delete-completion', async () => {
        await inngest.send({
          name: 'entities.delete.completed',
          data: { entityId },
          user: { id: userId },
        });
      });
      
      return {
        success: true,
        action: 'delete',
        entityId,
      };
    }
    
    throw new Error(`Unknown action: ${action}`);
  }
);
