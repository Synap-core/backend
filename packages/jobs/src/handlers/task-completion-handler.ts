/**
 * Task Completion Handler - V0.6: Pure Event-Driven
 * 
 * Handles 'task.completion.requested' events.
 * 
 * Responsibilities:
 * 1. Update task_details to mark task as completed
 * 2. Update entity updatedAt timestamp
 * 3. Publish 'task.completion.completed' event
 */

import { IEventHandler, type InngestStep, type HandlerResult } from './interface.js';
import { createSynapEvent, EventTypes, type SynapEvent } from '@synap/types';
import { db, entities, taskDetails } from '@synap/database';
import { inngest } from '../client.js';
import { createLogger } from '@synap/core';
import { eq } from 'drizzle-orm';

const logger = createLogger({ module: 'task-completion-handler' });

export class TaskCompletionHandler implements IEventHandler {
  eventType = EventTypes.TASK_COMPLETION_REQUESTED;

  async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
    if (event.type !== EventTypes.TASK_COMPLETION_REQUESTED) {
      return {
        success: false,
        message: `Invalid event type: expected '${EventTypes.TASK_COMPLETION_REQUESTED}', got '${event.type}'`,
      };
    }

    const { completedAt } = event.data as {
      completedAt?: string;
    };

    const entityId = event.aggregateId;
    const userId = event.userId;
    const completedTimestamp = completedAt ? new Date(completedAt) : new Date();

    if (!entityId) {
      return {
        success: false,
        message: 'Task ID (aggregateId) is required',
      };
    }

    logger.info({ entityId, userId }, 'Processing task completion request');

    try {
      // Step 1: Update task_details to mark as completed
      await step.run('update-task-details', async () => {
        await db
          .update(taskDetails)
          .set({
            status: 'done',
            completedAt: completedTimestamp,
          } as any)
          .where(eq(taskDetails.entityId, entityId) as any);

        logger.debug({ entityId }, 'Updated task details to completed');
      });

      // Step 2: Update entity updatedAt timestamp
      await step.run('update-entity-timestamp', async () => {
        await db
          .update(entities)
          .set({
            updatedAt: new Date(),
          } as any)
          .where(eq(entities.id, entityId) as any);

        logger.debug({ entityId }, 'Updated entity timestamp');
      });

      // Step 3: Publish completion event
      await step.run('publish-completion-event', async () => {
        const completionEvent = createSynapEvent({
          type: EventTypes.TASK_COMPLETION_COMPLETED,
          userId,
          aggregateId: entityId,
          data: {
            entityId,
            completedAt: completedTimestamp.toISOString(),
            status: 'done',
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

        logger.info({ entityId, completionEventId: completionEvent.id }, 'Published task.completion.completed event');
      });

      // Step 4: Broadcast notification to connected clients
      await step.run('broadcast-notification', async () => {
        const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
        const broadcastResult = await broadcastNotification({
          userId,
          requestId: event.requestId,
          message: {
            type: 'task.completion.completed',
            data: {
              entityId,
              completedAt: completedTimestamp.toISOString(),
              status: 'done',
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
        message: `Task ${entityId} completed successfully`,
      };
    } catch (error) {
      logger.error({ err: error, entityId, userId }, 'Task completion failed');
      
      // Broadcast error notification
      try {
        const { broadcastError } = await import('../utils/realtime-broadcast.js');
        await broadcastError(
          userId,
          'task.completion.failed',
          error instanceof Error ? error.message : String(error),
          { requestId: event.requestId }
        );
      } catch (broadcastErr) {
        logger.warn({ err: broadcastErr }, 'Failed to broadcast error notification');
      }
      
      return {
        success: false,
        message: `Task completion failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

