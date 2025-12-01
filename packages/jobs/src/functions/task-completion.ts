/**
 * Task Completion Handler - Inngest Function
 * Subscribes to: task.completion.requested
 */

import { inngest } from '../client.js';
import { EventTypes } from '@synap/types';
import { entities, taskDetails, eq } from '@synap/database';
import { createLogger } from '@synap/core';

const logger = createLogger({ module: 'task-completion-handler' });

export const handleTaskCompletion = inngest.createFunction(
  {
    id: 'task-completion-handler',
    name: 'Task Completion Handler',
    retries: 3,
  },
  { event: EventTypes.TASK_COMPLETION_REQUESTED },
  async ({ event, step }) => {
    const { completedAt } = event.data as { completedAt?: string };
    const entityId = event.data.entityId;
    const userId = event.user.id;
    const completedTimestamp = completedAt ? new Date(completedAt) : new Date();

    if (!entityId) {
      throw new Error('Task ID (entityId) is required');
    }

    logger.info({ entityId, userId }, 'Processing task completion request');

    await step.run('update-task-details', async () => {
      const { getDb } = await import('@synap/database');
      const db = await getDb();
      
      await db
        .update(taskDetails)
        .set({ status: 'done', completedAt: completedTimestamp } as any)
        .where(eq(taskDetails.entityId, entityId) as any);

      logger.debug({ entityId }, 'Updated task details to completed');
    });

    await step.run('update-entity-timestamp', async () => {
      const { getDb } = await import('@synap/database');
      const db = await getDb();
      
      await db
        .update(entities)
        .set({ updatedAt: new Date() } as any)
        .where(eq(entities.id, entityId) as any);

      logger.debug({ entityId }, 'Updated entity timestamp');
    });

    await step.run('publish-completion-event', async () => {
      await inngest.send({
        name: EventTypes.TASK_COMPLETION_COMPLETED,
        data: {
          entityId,
          completedAt: completedTimestamp.toISOString(),
          status: 'done',
        },
        user: { id: userId },
      });

      logger.info({ entityId }, 'Published task.completion.completed event');
    });

    return {
      success: true,
      entityId,
      message: `Task ${entityId} completed successfully`,
    };
  }
);
