/**
 * Task Creation Handler - V0.6: Pure Event-Driven
 * 
 * Handles 'task.creation.requested' events.
 * 
 * Responsibilities:
 * 1. Create task entity in database projection
 * 2. Create task_details record
 * 3. Publish 'task.creation.completed' event
 * 
 * This handler demonstrates the event-driven pattern:
 * - Receives intent event (task.creation.requested)
 * - Executes business logic (DB writes)
 * - Publishes completion event (task.creation.completed)
 */

import { IEventHandler, type InngestStep, type HandlerResult } from './interface.js';
import { createSynapEvent, EventTypes, type SynapEvent } from '@synap/types';
import { db, entities, taskDetails } from '@synap/database';
import { inngest } from '../client.js';
import { createLogger } from '@synap/core';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'task-creation-handler' });

export class TaskCreationHandler implements IEventHandler {
  eventType = EventTypes.TASK_CREATION_REQUESTED;

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    if (event.type !== EventTypes.TASK_CREATION_REQUESTED) {
      return {
        success: false,
        message: `Invalid event type: expected '${EventTypes.TASK_CREATION_REQUESTED}', got '${event.type}'`,
      };
    }

    // Validate event data structure
    const { title, description, dueDate, priority, status, projectId } = event.data as {
      title: string;
      description?: string;
      preview?: string;
      dueDate?: string;
      priority?: number;
      status?: string;
      projectId?: string;
    };

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return {
        success: false,
        message: 'Task title is required and cannot be empty',
      };
    }

    const entityId = event.aggregateId || randomUUID();
    const userId = event.userId;
    const preview = description || title;

    logger.info({ entityId, userId, title }, 'Processing task creation request');

    try {
      // Step 1: Create entity in database projection
      await step.run('create-entity-projection', async () => {
        await db.insert(entities).values({
          id: entityId,
          userId,
          type: 'task',
          title,
          preview: preview.slice(0, 500),
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);

        logger.debug({ entityId }, 'Created task entity projection');
      });

      // Step 2: Create task_details record
      await step.run('create-task-details', async () => {
        await db.insert(taskDetails).values({
          entityId,
          status: status || 'todo',
          priority: priority || 0,
          dueDate: dueDate ? new Date(dueDate) : null,
        } as any);

        logger.debug({ entityId, status: status || 'todo' }, 'Created task details');
      });

      // Step 3: Publish completion event
      await step.run('publish-completion-event', async () => {
        const completionEvent = createSynapEvent({
          type: EventTypes.TASK_CREATION_COMPLETED,
          userId,
          aggregateId: entityId,
          data: {
            entityId,
            title,
            status: status || 'todo',
            priority: priority || 0,
            dueDate,
            projectId,
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

        logger.info({ entityId, completionEventId: completionEvent.id }, 'Published task.creation.completed event');
      });

      // Step 4: Broadcast notification to connected clients
      await step.run('broadcast-notification', async () => {
        const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
        const broadcastResult = await broadcastNotification({
          userId,
          requestId: event.requestId,
          message: {
            type: 'task.creation.completed',
            data: {
              entityId,
              title,
              status: status || 'todo',
              priority: priority || 0,
              dueDate,
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
        message: `Task ${entityId} created successfully`,
      };
    } catch (error) {
      logger.error({ err: error, entityId, userId }, 'Task creation failed');
      
      // Broadcast error notification
      try {
        const { broadcastError } = await import('../utils/realtime-broadcast.js');
        await broadcastError(
          userId,
          'task.creation.failed',
          error instanceof Error ? error.message : String(error),
          { requestId: event.requestId }
        );
      } catch (broadcastErr) {
        logger.warn({ err: broadcastErr }, 'Failed to broadcast error notification');
      }
      
      return {
        success: false,
        message: `Task creation failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

