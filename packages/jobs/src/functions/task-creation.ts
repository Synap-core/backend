/**
 * Task Creation Handler - Inngest Function
 * 
 * Subscribes to: task.creation.requested
 * 
 * Responsibilities:
 * 1. Create task entity in database projection
 * 2. Create task_details record (if applicable)
 * 3. Publish task.creation.completed event
 * 4. Broadcast notification to connected clients
 */

import { inngest } from '../client.js';
import { EventTypes } from '@synap/types';
import { entities, taskDetails } from '@synap/database';
import { createLogger } from '@synap/core';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'task-creation-handler' });

export const handleTaskCreation = inngest.createFunction(
  {
    id: 'task-creation-handler',
    name: 'Task Creation Handler',
    retries: 3,
  },
  { event: EventTypes.TASK_CREATION_REQUESTED },
  async ({ event, step }) => {
    const { title, description, dueDate, priority, status, projectId } = event.data as {
      title: string;
      description?: string;
      dueDate?: string;
      priority?: number;
      status?: string;
      projectId?: string;
    };

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('Task title is required and cannot be empty');
    }

    const entityId = event.data.entityId || randomUUID();
    const userId = event.user.id;
    const preview = description || title;

    logger.info({ entityId, userId, title }, 'Processing task creation request');

    // Step 1: Create entity in database projection
    await step.run('create-entity-projection', async () => {
      const { getDb } = await import('@synap/database');
      const db = await getDb();
      
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
    if (dueDate || priority !== undefined) {
      await step.run('create-task-details', async () => {
        const { getDb } = await import('@synap/database');
        const db = await getDb();
        
        await db.insert(taskDetails).values({
          taskId: entityId,
          priority: priority ?? 0,
          dueDate: dueDate ? new Date(dueDate) : null,
          tagNames: [],
        } as any);
        
        logger.debug({ entityId }, 'Created task_details record');
      });
    }

    // Step 3: Publish completion event
    await step.run('publish-completion-event', async () => {
      await inngest.send({
        name: EventTypes.TASK_CREATION_COMPLETED,
        data: {
          entityId,
          title,
          status: status || 'todo',
          priority: priority || 0,
          dueDate,
          projectId,
        },
        user: { id: userId },
      });

      logger.info({ entityId }, 'Published task.creation.completed event');
    });

    // Step 4: Broadcast notification to connected clients
    await step.run('broadcast-notification', async () => {
      const { broadcastNotification } = await import('../utils/realtime-broadcast.js');
      const broadcastResult = await broadcastNotification({
        userId,
        requestId: event.data.requestId,
        message: {
          type: 'task.creation.completed',
          data: {
            entityId,
            title,
            status: status || 'todo',
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
      message: `Task ${entityId} created successfully`,
    };
  }
);
