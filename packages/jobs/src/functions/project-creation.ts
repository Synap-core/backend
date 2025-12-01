/**
 * Project Creation Handler - Inngest Function
 * Subscribes to: project.creation.requested
 */

import { inngest } from '../client.js';
import { EventTypes } from '@synap/types';
import { entities } from '@synap/database';
import { createLogger } from '@synap/core';
import { randomUUID } from 'crypto';

const logger = createLogger({ module: 'project-creation-handler' });

export const handleProjectCreation = inngest.createFunction(
  {
    id: 'project-creation-handler',
    name: 'Project Creation Handler',
    retries: 3,
  },
  { event: EventTypes.PROJECT_CREATION_REQUESTED },
  async ({ event, step }) => {
    const { title, description, startDate, endDate } = event.data as {
      title: string;
      description?: string;
      startDate?: string;
      endDate?: string;
    };

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new Error('Project title is required and cannot be empty');
    }

    const entityId = event.data.entityId || randomUUID();
    const userId = event.user.id;
    const preview = description || title;

    logger.info({ entityId, userId, title }, 'Processing project creation request');

    await step.run('create-entity-projection', async () => {
      const { getDb } = await import('@synap/database');
      const db = await getDb();
      
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

    await step.run('publish-completion-event', async () => {
      await inngest.send({
        name: EventTypes.PROJECT_CREATION_COMPLETED,
        data: { entityId, title, description, startDate, endDate },
        user: { id: userId },
      });

      logger.info({ entityId }, 'Published project.creation.completed event');
    });

    return {
      success: true,
      entityId,
      message: `Project ${entityId} created successfully`,
    };
  }
);
