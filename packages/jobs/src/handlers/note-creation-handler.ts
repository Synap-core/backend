/**
 * Note Creation Handler - Phase 2: Worker Layer
 * 
 * Handles 'note.creation.requested' events.
 * 
 * Responsibilities:
 * 1. Upload note content to storage (R2/MinIO)
 * 2. Create entity record in database projection
 * 3. Publish 'note.creation.completed' event
 * 
 * This handler demonstrates the event-driven pattern:
 * - Receives intent event (note.creation.requested)
 * - Executes business logic (storage + DB)
 * - Publishes completion event (note.creation.completed)
 */

import { IEventHandler, type InngestStep, type HandlerResult } from './interface.js';
import { createSynapEvent, EventTypes, type SynapEvent } from '@synap/types';
import { storage } from '@synap/storage';
import { db, entities } from '@synap/database';
import { inngest } from '../client.js';
import { createLogger } from '@synap/core';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'note-creation-handler' });

export class NoteCreationHandler implements IEventHandler {
  eventType = EventTypes.NOTE_CREATION_REQUESTED;

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    if (event.type !== EventTypes.NOTE_CREATION_REQUESTED) {
      return {
        success: false,
        message: `Invalid event type: expected '${EventTypes.NOTE_CREATION_REQUESTED}', got '${event.type}'`,
      };
    }

    // Validate event data structure
    const { content, title } = event.data as {
      content: string;
      title?: string;
      tags?: string[];
    };

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return {
        success: false,
        message: 'Note content is required and cannot be empty',
      };
    }

    const entityId = event.aggregateId || randomUUID();
    const userId = event.userId;

    logger.info({ entityId, userId }, 'Processing note creation request');

    try {
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
        const completionEvent = createSynapEvent({
          type: EventTypes.NOTE_CREATION_COMPLETED,
          userId,
          aggregateId: entityId,
          data: {
            entityId,
            fileUrl: fileMetadata.url,
            filePath: fileMetadata.path,
            fileSize: fileMetadata.size,
            fileType: 'markdown',
            checksum: fileMetadata.checksum,
          },
          source: 'automation',
          causationId: event.id, // This event was caused by the request event
          correlationId: event.correlationId || event.id, // Group related events
          requestId: event.requestId, // Link to original API request
        });

        // Publish to Inngest (not directly to EventRepository - that's for testing)
        await inngest.send({
          name: 'api/event.logged',
          data: {
            id: completionEvent.id,
            type: completionEvent.type,
            aggregateId: completionEvent.aggregateId,
            aggregateType: 'entity',
            userId: completionEvent.userId,
            version: 1,
            timestamp: completionEvent.timestamp.toISOString(),
            data: completionEvent.data,
            metadata: { version: completionEvent.version, requestId: completionEvent.requestId },
            source: completionEvent.source,
            causationId: completionEvent.causationId,
            correlationId: completionEvent.correlationId,
            requestId: completionEvent.requestId,
          },
        });

        logger.info({ entityId, completionEventId: completionEvent.id }, 'Published note.creation.completed event');
      });

      // Step 4: Broadcast notification to connected clients
      await step.run('broadcast-notification', async () => {
        const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
        const broadcastResult = await broadcastNotification({
          userId,
          requestId: event.requestId,
          message: {
            type: 'note.creation.completed',
            data: {
              entityId,
              fileUrl: fileMetadata.url,
              filePath: fileMetadata.path,
              title,
            },
            requestId: event.requestId,
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
        message: `Note ${entityId} created successfully`,
      };
    } catch (error) {
      logger.error({ err: error, entityId, userId }, 'Note creation failed');
      
      // Broadcast error notification
      try {
        const { broadcastError } = await import('../utils/realtime-broadcast.js');
        await broadcastError(
          userId,
          'note.creation.failed',
          error instanceof Error ? error.message : String(error),
          { requestId: event.requestId }
        );
      } catch (broadcastErr) {
        logger.warn({ err: broadcastErr }, 'Failed to broadcast error notification');
      }
      
      return {
        success: false,
        message: `Note creation failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

