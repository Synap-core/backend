/**
 * Note Creation Handler - Inngest Function
 * 
 * Subscribes to: note.creation.requested
 * 
 * Responsibilities:
 * 1. Upload note content to storage (MinIO/R2)
 * 2. Create entity record in database projection
 * 3. Publish note.creation.completed event
 * 4. Broadcast notification to connected clients
 */

import { inngest } from '../client.js';
import { EventTypes } from '@synap/types';
import { storage } from '@synap/storage';
import { entities } from '@synap/database';
import { createLogger } from '@synap/core';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'note-creation-handler' });

export const handleNoteCreation = inngest.createFunction(
  {
    id: 'note-creation-handler',
    name: 'Note Creation Handler',
    retries: 3,
  },
  { event: EventTypes.NOTE_CREATION_REQUESTED },
  async ({ event, step }) => {
    const { content, title } = event.data as {
      content: string;
      title?: string;
      tags?: string[];
    };

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      throw new Error('Note content is required and cannot be empty');
    }

    const entityId = event.data.entityId || randomUUID();
    const userId = event.user.id;

    logger.info({ entityId, userId }, 'Processing note creation request');

    // Step 1: Upload content to storage
    const fileMetadata = await step.run('upload-to-storage', async () => {
      const storagePath = storage.buildPath(userId, 'note', entityId, 'md');
      const metadata = await storage.upload(storagePath, content, {
        contentType: 'text/markdown',
      });
      logger.debug({ storagePath: metadata.path, size: metadata.size }, 'Uploaded note to storage');
      return metadata;
    });

    // Step 2: Create entity in database projection
    await step.run('create-entity-projection', async () => {
      const { getDb } = await import('@synap/database');
      const db = await getDb();
      
      const noteTitle = title || content.split('\n')[0]?.slice(0, 100) || 'Untitled Note';
      const preview = content.slice(0, 500);

      await db.insert(entities).values({
        id: entityId,
        userId,
        type: 'note',
        title: noteTitle,
        preview,
        fileUrl: fileMetadata.url,
        filePath: fileMetadata.path,
        fileSize: fileMetadata.size,
        fileType: 'markdown',
        checksum: fileMetadata.checksum,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      logger.debug({ entityId }, 'Created entity projection');
    });

    // Step 3: Publish completion event
    await step.run('publish-completion-event', async () => {
      await inngest.send({
        name: EventTypes.NOTE_CREATION_COMPLETED,
        data: {
          entityId,
          fileUrl: fileMetadata.url,
          filePath: fileMetadata.path,
          fileSize: fileMetadata.size,
          fileType: 'markdown',
          checksum: fileMetadata.checksum,
        },
        user: { id: userId },
      });

      logger.info({ entityId }, 'Published note.creation.completed event');
    });

    // Step 4: Broadcast notification to connected clients
    await step.run('broadcast-notification', async () => {
      const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
      const broadcastResult = await broadcastNotification({
        userId,
        requestId: event.data.requestId,
        message: {
          type: 'note.creation.completed',
          data: {
            entityId,
            fileUrl: fileMetadata.url,
            filePath: fileMetadata.path,
            title,
          },
          requestId: event.data.requestId,
          status: 'success',
          timestamp: new Date().toISOString(),
        },
      });

      if (broadcastResult.success) {
        logger.debug({ entityId, broadcastCount: broadcastResult.broadcastCount }, 'Notification broadcasted');
      } else {
        logger.warn({ entityId, error: broadcastResult.error }, 'Failed to broadcast notification');
      }
    });

    return {
      success: true,
      entityId,
      message: `Note ${entityId} created successfully`,
    };
  }
);
