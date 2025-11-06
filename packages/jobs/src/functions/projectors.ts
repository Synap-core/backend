/**
 * Event Projectors
 * 
 * These functions listen to the event stream and update the SQL database
 * (the "materialized view" of the system state).
 */

import { inngest } from '../client.js';
import { db, entities, contentBlocks, taskDetails, tags, entityTags } from '@synap/database';

/**
 * Main event handler
 * 
 * Listens to all logged events and updates projections accordingly
 */
export const handleNewEvent = inngest.createFunction(
  { id: 'event-projector', name: 'Handle New Event' },
  { event: 'api/event.logged' },
  async ({ event, step }) => {
    const { type, data } = event.data;

    console.log(`📨 Processing event: ${type}`);

    // Step 1: Log the event processing
    await step.run('log-event-processing', async () => {
      console.log(`Event data:`, JSON.stringify(data, null, 2));
      return { status: 'logged', eventType: type };
    });

    // Step 2: Update projections based on event type
    await step.run('update-projections', async () => {
      switch (type) {
        case 'entity.created':
          return await handleEntityCreated(data);
        
        case 'entity.updated':
          return await handleEntityUpdated(data);
        
        case 'entity.deleted':
          return await handleEntityDeleted(data);
        
        case 'task.completed':
          return await handleTaskCompleted(data);
        
        default:
          console.log(`⚠️  No projection handler for event type: ${type}`);
          return { status: 'no-handler' };
      }
    });

    return { event: event.name, status: 'processed' };
  }
);

/**
 * Handle entity.created event
 */
async function handleEntityCreated(data: any) {
  const { entityId, type, title, content, tagNames } = data;

  // 1. Create entity record
  await db.insert(entities).values({
    id: entityId,
    type,
    title,
    preview: content?.substring(0, 200),
  });

  // 2. If there's content, store it
  if (content) {
    await db.insert(contentBlocks).values({
      entityId,
      content,
      storageProvider: 'db',
      contentType: 'markdown',
      sizeBytes: Buffer.byteLength(content, 'utf-8'),
    });
  }

  // 3. If it's a task, create task details
  if (type === 'task' && data.dueDate) {
    await db.insert(taskDetails).values({
      entityId,
      status: 'todo',
      dueDate: new Date(data.dueDate),
      priority: data.priority || 0,
    });
  }

  // 4. Handle tags
  if (tagNames && tagNames.length > 0) {
    for (const tagName of tagNames) {
      // Find or create tag
      const existingTags = await db.select().from(tags).all();
      let tag = existingTags.find((t: any) => t.name === tagName);
      
      if (!tag) {
        // Create new tag
        const [newTag] = await db.insert(tags).values({ name: tagName }).returning();
        tag = newTag;
      }
      
      // Link entity to tag
      await db.insert(entityTags).values({
        entityId,
        tagId: tag.id,
      });
    }
  }

  console.log(`✅ Created entity ${entityId} of type ${type} with ${tagNames?.length || 0} tags`);
  return { status: 'created', entityId };
}

/**
 * Handle entity.updated event
 */
async function handleEntityUpdated(data: any) {
  const { entityId } = data;

  // Use raw SQL for updates to avoid Drizzle type issues
  if (db.run) {
    db.run(`UPDATE entities SET updated_at = ? WHERE id = ?`, [Date.now(), entityId]);
  }

  console.log(`✅ Updated entity ${entityId}`);
  return { status: 'updated', entityId };
}

/**
 * Handle entity.deleted event (soft delete)
 */
async function handleEntityDeleted(data: any) {
  const { entityId } = data;

  // Use raw SQL for soft delete
  if (db.run) {
    db.run(`UPDATE entities SET deleted_at = ? WHERE id = ?`, [Date.now(), entityId]);
  }

  console.log(`✅ Soft-deleted entity ${entityId}`);
  return { status: 'deleted', entityId };
}

/**
 * Handle task.completed event
 */
async function handleTaskCompleted(data: any) {
  const { entityId } = data;

  // Use raw SQL for task update
  if (db.run) {
    db.run(`UPDATE task_details SET status = 'done' WHERE entity_id = ?`, [entityId]);
  }

  console.log(`✅ Marked task ${entityId} as completed`);
  return { status: 'completed', entityId };
}
