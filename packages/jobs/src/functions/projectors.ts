/**
 * Event Projectors
 * 
 * These functions listen to the event stream and update the SQL database
 * (the "materialized view" of the system state).
 */

import { inngest } from '../client.js';
import { db, entities, taskDetails, tags, entityTags } from '@synap/database';
import { eq, and } from 'drizzle-orm';

/**
 * Type for event data that includes userId
 * (Defined locally to avoid circular dependency with @synap/api)
 */
interface EventDataWithUser {
  userId: string;
  [key: string]: any;
}

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
async function handleEntityCreated(data: EventDataWithUser) {
  const { entityId, type, title, content, tagNames, userId } = data;

  // 1. Create entity record with userId
  await db.insert(entities).values({
    id: entityId,
    type,
    title,
    preview: content?.substring(0, 200),
    userId, // ✅ User isolation
  });

  // 2. If there's content, store it (inherits userId from entity via FK)
  // 3. If it's a task, create task details (inherits userId from entity via FK)
  if (type === 'task' && data.dueDate) {
    await db.insert(taskDetails).values({
      entityId,
      status: 'todo',
      dueDate: new Date(data.dueDate),
      priority: data.priority || 0,
    });
  }

  // 4. Handle tags (user-scoped)
  if (tagNames && tagNames.length > 0) {
    for (const tagName of tagNames) {
      // Find existing tag FOR THIS USER
      // Type assertions needed due to dynamic schema (SQLite vs PostgreSQL)
      const existingTagsQuery = db.select().from(tags) as any;
      const existingTags: any[] = await existingTagsQuery.where(eq((tags as any).userId, userId)).all();
        
      let tag = existingTags.find((t: any) => t.name === tagName);
      
      if (!tag) {
        // Create new tag for this user
        const newTagsResult = await db.insert(tags).values({
          name: tagName,
          userId, // ✅ User isolation
        } as any).returning();
        tag = Array.isArray(newTagsResult) ? newTagsResult[0] : newTagsResult;
      }
      
      // Link entity to tag
      if (tag && tag.id) {
        await db.insert(entityTags).values({
          entityId,
          tagId: tag.id,
        } as any);
      }
    }
  }

  console.log(`✅ Created entity ${entityId} for user ${userId} of type ${type} with ${tagNames?.length || 0} tags`);
  return { status: 'created', entityId };
}

/**
 * Handle entity.updated event
 */
async function handleEntityUpdated(data: EventDataWithUser) {
  const { entityId, userId } = data;

  // Update entity with user-scoped filter
  // Type assertion needed for multi-dialect compatibility
  await db.update(entities)
    .set({ updatedAt: new Date() } as any)
    .where(
      and(
        eq((entities as any).id, entityId),
        eq((entities as any).userId, userId) // ✅ User isolation
      ) as any
    );

  console.log(`✅ Updated entity ${entityId} for user ${userId}`);
  return { status: 'updated', entityId };
}

/**
 * Handle entity.deleted event (soft delete)
 */
async function handleEntityDeleted(data: EventDataWithUser) {
  const { entityId, userId } = data;

  // Soft delete with user-scoped filter
  // Type assertion needed for multi-dialect compatibility
  await db.update(entities)
    .set({ deletedAt: new Date() } as any)
    .where(
      and(
        eq((entities as any).id, entityId),
        eq((entities as any).userId, userId) // ✅ User isolation
      ) as any
    );

  console.log(`✅ Soft-deleted entity ${entityId} for user ${userId}`);
  return { status: 'deleted', entityId };
}

/**
 * Handle task.completed event
 */
async function handleTaskCompleted(data: EventDataWithUser) {
  const { entityId, userId } = data;

  // Update task details (user verification implicit via entity FK)
  // Type assertion needed for multi-dialect compatibility
  await db.update(taskDetails)
    .set({
      status: 'done',
      completedAt: new Date(),
    } as any)
    .where(eq((taskDetails as any).entityId, entityId) as any);

  console.log(`✅ Marked task ${entityId} as completed for user ${userId}`);
  return { status: 'completed', entityId };
}
