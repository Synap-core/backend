/**
 * Project Creation Handler - V0.6: Pure Event-Driven
 * 
 * Handles 'project.creation.requested' events.
 * 
 * Responsibilities:
 * 1. Create project entity in database projection
 * 2. Publish 'project.creation.completed' event
 * 
 * Note: Project tasks are created separately via task.creation.requested events
 */

import { IEventHandler, type InngestStep, type HandlerResult } from './interface.js';
import { createSynapEvent, EventTypes, type SynapEvent } from '@synap/types';
import { db, entities } from '@synap/database';
import { inngest } from '../client.js';
import { createLogger } from '@synap/core';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'project-creation-handler' });

export class ProjectCreationHandler implements IEventHandler {
  eventType = EventTypes.PROJECT_CREATION_REQUESTED;

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    if (event.type !== EventTypes.PROJECT_CREATION_REQUESTED) {
      return {
        success: false,
        message: `Invalid event type: expected '${EventTypes.PROJECT_CREATION_REQUESTED}', got '${event.type}'`,
      };
    }

    // Validate event data structure
    const { title, description, startDate, endDate } = event.data as {
      title: string;
      description?: string;
      startDate?: string;
      endDate?: string;
    };

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return {
        success: false,
        message: 'Project title is required and cannot be empty',
      };
    }

    const entityId = event.aggregateId || randomUUID();
    const userId = event.userId;
    const preview = description || title;

    logger.info({ entityId, userId, title }, 'Processing project creation request');

    try {
      // Step 1: Create entity in database projection
      await step.run('create-entity-projection', async () => {
        await db.insert(entities).values({
          id: entityId,
          userId,
          type: 'project',
          title,
          preview: preview.slice(0, 500),
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);

        logger.debug({ entityId }, 'Created project entity projection');
      });

      // Step 2: Publish completion event
      await step.run('publish-completion-event', async () => {
        const completionEvent = createSynapEvent({
          type: EventTypes.PROJECT_CREATION_COMPLETED,
          userId,
          aggregateId: entityId,
          data: {
            entityId,
            title,
            description,
            startDate,
            endDate,
          },
          source: 'automation',
          causationId: event.id,
          correlationId: event.correlationId || event.id,
          requestId: event.requestId,
        });

        // Publish to Inngest
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

        logger.info({ entityId, completionEventId: completionEvent.id }, 'Published project.creation.completed event');
      });

      // Step 3: Broadcast notification to connected clients
      await step.run('broadcast-notification', async () => {
        const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
        const broadcastResult = await broadcastNotification({
          userId,
          requestId: event.requestId,
          message: {
            type: 'project.creation.completed',
            data: {
              entityId,
              title,
              description,
              startDate,
              endDate,
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
        message: `Project ${entityId} created successfully`,
      };
    } catch (error) {
      logger.error({ err: error, entityId, userId }, 'Project creation failed');
      
      // Broadcast error notification
      try {
        const { broadcastError } = await import('../utils/realtime-broadcast.js');
        await broadcastError(
          userId,
          'project.creation.failed',
          error instanceof Error ? error.message : String(error),
          { requestId: event.requestId }
        );
      } catch (broadcastErr) {
        logger.warn({ err: broadcastErr }, 'Failed to broadcast error notification');
      }
      
      return {
        success: false,
        message: `Project creation failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

