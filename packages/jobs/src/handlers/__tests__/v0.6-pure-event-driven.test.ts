/**
 * V0.6 Integration Test - Pure Event-Driven Architecture
 * 
 * Tests the complete pure event-driven workflow:
 * 1. API/Agents publish intent events (no business logic)
 * 2. Workers handle business logic and update projections
 * 3. Verify projections are updated correctly after async processing
 * 
 * This test validates:
 * - Event producers (API/Agents) only publish events
 * - Event consumers (Workers) handle all business logic
 * - Projections are updated correctly after async processing
 * - Complete event flow: API → Event Store → Inngest → Workers → Projections
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSynapEvent, EventTypes } from '@synap/types';
import { getEventRepository } from '@synap/database';
import { db, entities, taskDetails } from '@synap/database';
import { inngest } from '../../client.js';
import { handlerRegistry } from '../registry.js';
import { NoteCreationHandler } from '../note-creation-handler.js';
import { TaskCreationHandler } from '../task-creation-handler.js';
import { TaskCompletionHandler } from '../task-completion-handler.js';
import { ProjectCreationHandler } from '../project-creation-handler.js';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

// Register all handlers for testing
const noteCreationHandler = new NoteCreationHandler();
const taskCreationHandler = new TaskCreationHandler();
const taskCompletionHandler = new TaskCompletionHandler();
const projectCreationHandler = new ProjectCreationHandler();

handlerRegistry.register(noteCreationHandler);
handlerRegistry.register(taskCreationHandler);
handlerRegistry.register(taskCompletionHandler);
handlerRegistry.register(projectCreationHandler);

describe('V0.6: Pure Event-Driven Architecture', () => {
  const testUserId = `test-user-${randomUUID()}`;
  const testRequestId = randomUUID();
  const testCorrelationId = randomUUID();

  beforeAll(() => {
    // Ensure handlers are registered
    expect(handlerRegistry.getHandlers(EventTypes.NOTE_CREATION_REQUESTED).length).toBeGreaterThan(0);
    expect(handlerRegistry.getHandlers(EventTypes.TASK_CREATION_REQUESTED).length).toBeGreaterThan(0);
    expect(handlerRegistry.getHandlers(EventTypes.TASK_COMPLETION_REQUESTED).length).toBeGreaterThan(0);
    expect(handlerRegistry.getHandlers(EventTypes.PROJECT_CREATION_REQUESTED).length).toBeGreaterThan(0);
  });

  afterAll(async () => {
    // Cleanup test data
    try {
      // Delete all test entities
      await db.delete(entities).where(eq(entities.userId, testUserId) as any);
    } catch (error) {
      console.warn('Cleanup failed:', error);
    }
  });

  /**
   * Helper function to publish an event and wait for processing
   */
  async function publishAndWait(event: ReturnType<typeof createSynapEvent>, waitMs = 3000) {
    // Append to Event Store
    const eventRepo = getEventRepository();
    const eventRecord = await eventRepo.append(event);

    // Publish to Inngest
    await inngest.send({
      name: 'api/event.logged',
      data: {
        id: eventRecord.id,
        type: eventRecord.eventType,
        aggregateId: eventRecord.aggregateId,
        aggregateType: eventRecord.aggregateType || 'entity',
        userId: eventRecord.userId,
        version: 1,
        timestamp: eventRecord.timestamp.toISOString(),
        data: eventRecord.data,
        metadata: { version: eventRecord.version, requestId: eventRecord.metadata?.requestId, ...eventRecord.metadata },
        source: eventRecord.source,
        causationId: eventRecord.causationId,
        correlationId: eventRecord.correlationId,
        requestId: eventRecord.metadata?.requestId,
      },
    });

    // Wait for handlers to process
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    return eventRecord;
  }

  describe('Task Creation Workflow', () => {
    it('should create task via event-driven flow', async () => {
      const taskId = randomUUID();
      const taskTitle = 'Test Task for V0.6';
      const taskDescription = 'This is a test task created via pure event-driven flow';
      const dueDate = new Date(Date.now() + 86400000).toISOString(); // Tomorrow

      // Step 1: Publish task.creation.requested event (simulating API call)
      const event = createSynapEvent({
        type: EventTypes.TASK_CREATION_REQUESTED,
        userId: testUserId,
        aggregateId: taskId,
        data: {
          title: taskTitle,
          description: taskDescription,
          dueDate,
          priority: 2,
          status: 'todo',
        },
        source: 'api',
        requestId: testRequestId,
        correlationId: testCorrelationId,
      });

      await publishAndWait(event);

      // Step 2: Verify task entity was created in projection
      const entityRows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, taskId) as any)
        .limit(1);

      expect(entityRows.length).toBe(1);
      const entity = entityRows[0] as any;
      expect(entity.id).toBe(taskId);
      expect(entity.userId).toBe(testUserId);
      expect(entity.type).toBe('task');
      expect(entity.title).toBe(taskTitle);
      expect(entity.preview).toBeTruthy();

      // Step 3: Verify task_details was created
      const taskDetailRows = await db
        .select()
        .from(taskDetails)
        .where(eq(taskDetails.entityId, taskId) as any)
        .limit(1);

      expect(taskDetailRows.length).toBe(1);
      const taskDetail = taskDetailRows[0] as any;
      expect(taskDetail.entityId).toBe(taskId);
      expect(taskDetail.status).toBe('todo');
      expect(taskDetail.priority).toBe(2);
      expect(taskDetail.dueDate).toBeTruthy();
    }, 30000);

    it('should complete task via event-driven flow', async () => {
      // First, create a task
      const taskId = randomUUID();
      const createEvent = createSynapEvent({
        type: 'task.creation.requested',
        userId: testUserId,
        aggregateId: taskId,
        data: {
          title: 'Task to Complete',
          status: 'todo',
        },
        source: 'api',
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });

      await publishAndWait(createEvent, 2000);

      // Verify task exists
      const entityRows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, taskId) as any)
        .limit(1);
      expect(entityRows.length).toBe(1);

      // Now complete the task
      const completeEvent = createSynapEvent({
        type: EventTypes.TASK_COMPLETION_REQUESTED,
        userId: testUserId,
        aggregateId: taskId,
        data: {
          completedAt: new Date().toISOString(),
        },
        source: 'api',
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });

      await publishAndWait(completeEvent);

      // Verify task_details was updated
      const taskDetailRows = await db
        .select()
        .from(taskDetails)
        .where(eq(taskDetails.entityId, taskId) as any)
        .limit(1);

      expect(taskDetailRows.length).toBe(1);
      const taskDetail = taskDetailRows[0] as any;
      expect(taskDetail.status).toBe('done');
      expect(taskDetail.completedAt).toBeTruthy();

      // Verify entity updatedAt was updated
      const updatedEntityRows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, taskId) as any)
        .limit(1);
      expect(updatedEntityRows.length).toBe(1);
      const updatedEntity = updatedEntityRows[0] as any;
      expect(updatedEntity.updatedAt).toBeTruthy();
    }, 30000);
  });

  describe('Project Creation Workflow', () => {
    it('should create project via event-driven flow', async () => {
      const projectId = randomUUID();
      const projectTitle = 'Test Project for V0.6';
      const projectDescription = 'This is a test project created via pure event-driven flow';
      const startDate = new Date().toISOString();
      const endDate = new Date(Date.now() + 86400000 * 30).toISOString(); // 30 days from now

      // Step 1: Publish project.creation.requested event
      const event = createSynapEvent({
        type: EventTypes.PROJECT_CREATION_REQUESTED,
        userId: testUserId,
        aggregateId: projectId,
        data: {
          title: projectTitle,
          description: projectDescription,
          startDate,
          endDate,
        },
        source: 'api',
        requestId: testRequestId,
        correlationId: testCorrelationId,
      });

      await publishAndWait(event);

      // Step 2: Verify project entity was created in projection
      const entityRows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, projectId) as any)
        .limit(1);

      expect(entityRows.length).toBe(1);
      const entity = entityRows[0] as any;
      expect(entity.id).toBe(projectId);
      expect(entity.userId).toBe(testUserId);
      expect(entity.type).toBe('project');
      expect(entity.title).toBe(projectTitle);
      expect(entity.preview).toBeTruthy();
    }, 30000);
  });

  describe('Note Creation Workflow (Validation)', () => {
    it('should create note via event-driven flow', async () => {
      const noteId = randomUUID();
      const noteContent = '# Test Note for V0.6\n\nThis note is created via pure event-driven flow.';
      const noteTitle = 'Test Note';

      // Step 1: Publish note.creation.requested event
      const event = createSynapEvent({
        type: EventTypes.NOTE_CREATION_REQUESTED,
        userId: testUserId,
        aggregateId: noteId,
        data: {
          content: noteContent,
          title: noteTitle,
          tags: ['test', 'v0.6'],
        },
        source: 'api',
        requestId: testRequestId,
        correlationId: testCorrelationId,
      });

      await publishAndWait(event);

      // Step 2: Verify note entity was created in projection
      const entityRows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, noteId) as any)
        .limit(1);

      expect(entityRows.length).toBe(1);
      const entity = entityRows[0] as any;
      expect(entity.id).toBe(noteId);
      expect(entity.userId).toBe(testUserId);
      expect(entity.type).toBe('note');
      expect(entity.title).toBe(noteTitle);
      expect(entity.filePath).toBeTruthy(); // File reference from storage
      expect(entity.fileUrl).toBeTruthy(); // File reference from storage
      expect(entity.content).toBeUndefined(); // ✅ No content in DB (stored in storage)
    }, 30000);
  });

  describe('Event-Driven Compliance', () => {
    it('should verify all events are published, not directly calling services', async () => {
      // This test validates that the architecture is truly event-driven
      // by verifying that:
      // 1. Events are published to Inngest
      // 2. Workers process events asynchronously
      // 3. Projections are updated by workers, not by API/Agents

      const taskId = randomUUID();
      const event = createSynapEvent({
        type: 'task.creation.requested',
        userId: testUserId,
        aggregateId: taskId,
        data: {
          title: 'Compliance Test Task',
          status: 'todo',
        },
        source: 'api',
        requestId: testRequestId,
        correlationId: testCorrelationId,
      });

      // Publish event (simulating API mutation)
      const eventRepo = getEventRepository();
      const eventRecord = await eventRepo.append(event);

      // Verify event was stored (not processed yet)
      expect(eventRecord.id).toBe(event.id);
      expect(eventRecord.eventType).toBe(EventTypes.TASK_CREATION_REQUESTED);

      // Initially, entity should NOT exist (worker hasn't processed yet)
      const initialEntityRows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, taskId) as any)
        .limit(1);
      expect(initialEntityRows.length).toBe(0); // ✅ Entity doesn't exist yet

      // Publish to Inngest
      await inngest.send({
        name: 'api/event.logged',
        data: {
          id: eventRecord.id,
          type: eventRecord.eventType,
          aggregateId: eventRecord.aggregateId,
          aggregateType: 'entity',
          userId: eventRecord.userId,
          version: 1,
          timestamp: eventRecord.timestamp.toISOString(),
          data: eventRecord.data,
          metadata: { version: eventRecord.version, requestId: eventRecord.metadata?.requestId },
          source: eventRecord.source,
          causationId: eventRecord.causationId,
          correlationId: eventRecord.correlationId,
          requestId: eventRecord.metadata?.requestId,
        },
      });

      // Wait for worker to process
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Now entity should exist (worker processed the event)
      const finalEntityRows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, taskId) as any)
        .limit(1);
      expect(finalEntityRows.length).toBe(1); // ✅ Entity exists after worker processing

      const entity = finalEntityRows[0] as any;
      expect(entity.type).toBe('task');
      expect(entity.title).toBe('Compliance Test Task');
    }, 30000);
  });

  describe('Multiple Events in Sequence', () => {
    it('should handle multiple events in sequence correctly', async () => {
      // Create a project with multiple tasks
      const projectId = randomUUID();
      const task1Id = randomUUID();
      const task2Id = randomUUID();

      // Create project
      const projectEvent = createSynapEvent({
        type: EventTypes.PROJECT_CREATION_REQUESTED,
        userId: testUserId,
        aggregateId: projectId,
        data: {
          title: 'Multi-Event Test Project',
        },
        source: 'api',
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });

      await publishAndWait(projectEvent, 2000);

      // Create task 1
      const task1Event = createSynapEvent({
        type: 'task.creation.requested',
        userId: testUserId,
        aggregateId: task1Id,
        data: {
          title: 'Task 1',
          projectId,
          status: 'todo',
        },
        source: 'api',
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });

      await publishAndWait(task1Event, 2000);

      // Create task 2
      const task2Event = createSynapEvent({
        type: 'task.creation.requested',
        userId: testUserId,
        aggregateId: task2Id,
        data: {
          title: 'Task 2',
          projectId,
          status: 'todo',
        },
        source: 'api',
        requestId: randomUUID(),
        correlationId: randomUUID(),
      });

      await publishAndWait(task2Event, 2000);

      // Verify all entities were created
      const projectRows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, projectId) as any)
        .limit(1);
      expect(projectRows.length).toBe(1);

      const task1Rows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, task1Id) as any)
        .limit(1);
      expect(task1Rows.length).toBe(1);

      const task2Rows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, task2Id) as any)
        .limit(1);
      expect(task2Rows.length).toBe(1);
    }, 30000);
  });
});

