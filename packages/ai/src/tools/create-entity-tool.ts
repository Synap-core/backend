import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createSynapEvent, EventTypes } from '@synap/types';
import { getEventRepository } from '@synap/database';
import { ValidationError } from '@synap/core';
import type {
  AgentToolDefinition,
  AgentToolExecutionResult,
  CreateEntityPayload,
} from './types.js';

const createEntityInputSchema = z.object({
  type: z.enum(['note', 'task']),
  title: z.string().min(1),
  content: z
    .string()
    .optional()
    .describe('Primary body content. Required for notes.'),
  preview: z
    .string()
    .max(1000)
    .optional()
    .describe('Optional short preview text used in list views.'),
  dueDate: z
    .string()
    .datetime()
    .optional()
    .describe('ISO 8601 due date for task entities.'),
  tags: z.array(z.string()).optional(),
});

const ensureNoteContent = (type: 'note' | 'task', content?: string) => {
  if (type === 'note' && (!content || content.trim().length === 0)) {
    throw new ValidationError('Note creation requires non-empty content.', { type, hasContent: Boolean(content) });
  }
};

const toExecutionResult = (
  payload: CreateEntityPayload,
  startedAt: number,
  logs: string[]
): AgentToolExecutionResult<CreateEntityPayload> => {
  return {
    success: true,
    result: payload,
    metadata: {
      durationMs: Date.now() - startedAt,
      logs,
    },
  };
};

export const createEntityTool: AgentToolDefinition<
  typeof createEntityInputSchema,
  CreateEntityPayload
> = {
  name: 'createEntity',
  description:
    'Creates a new entity (note or task), uploads optional content to R2, and emits a creation event.',
  schema: createEntityInputSchema,
  execute: async (input, context) => {
    const startedAt = Date.now();
    const logs: string[] = [];

    ensureNoteContent(input.type, input.content);
    const entityId = randomUUID();
    const requestId = randomUUID();
    const correlationId = randomUUID();

    logs.push(`Generated entityId ${entityId}`);

    // V0.6: Pure Event-Driven - Publish intent events only
    // All business logic is handled by workers (Epic 2)
    if (input.type === 'note') {
      // Create and publish note.creation.requested event
      const event = createSynapEvent({
        type: EventTypes.NOTE_CREATION_REQUESTED,
        userId: context.userId,
        aggregateId: entityId,
        data: {
          content: input.content ?? '',
          title: input.title,
          tags: input.tags,
        },
        source: 'automation',
        requestId,
        correlationId,
      });
      
      // Store metadata for Inngest payload
      const eventMetadata = {
        orchestrator: 'synap-agent',
        tool: 'createEntity',
        threadId: context.threadId,
      };

      // Append to Event Store
      const eventRepo = getEventRepository();
      const eventRecord = await eventRepo.append(event);

      // Publish to Inngest (dynamic import to avoid cyclic dependency)
      // @ts-expect-error - Dynamic import of workspace package, resolved at runtime
      const { inngest } = await import('@synap/jobs');
      await inngest.send({
        name: 'api/event.logged',
        data: {
          id: event.id,
          type: event.type,
          aggregateId: event.aggregateId,
          aggregateType: 'entity',
          userId: event.userId,
          version: 1,
          timestamp: event.timestamp.toISOString(),
          data: event.data,
          metadata: { version: event.version, requestId: event.requestId, ...eventMetadata },
          source: event.source,
          causationId: event.causationId,
          correlationId: event.correlationId,
          requestId: event.requestId,
        },
      });

      logs.push(`Published note.creation.requested event ${eventRecord.id}.`);

      const resultPayload: CreateEntityPayload = {
        entityId,
        eventId: eventRecord.id,
        aggregateVersion: eventRecord.version,
      };

      return toExecutionResult(resultPayload, startedAt, logs);
    }

    // Task creation - publish task.creation.requested event
    const preview = input.preview ?? input.content?.slice(0, 500);

    const event = createSynapEvent({
      type: EventTypes.TASK_CREATION_REQUESTED,
      userId: context.userId,
      aggregateId: entityId,
      data: {
        title: input.title,
        preview,
        dueDate: input.dueDate,
        status: 'todo',
      },
      source: 'automation',
      requestId,
      correlationId,
    });
    
    // Store metadata for Inngest payload
    const taskEventMetadata = {
      orchestrator: 'synap-agent',
      tool: 'createEntity',
      threadId: context.threadId,
    };

    // Append to Event Store
    const eventRepo = getEventRepository();
    const eventRecord = await eventRepo.append(event);

    // Publish to Inngest (dynamic import to avoid cyclic dependency)
    // @ts-expect-error - Dynamic import of workspace package, resolved at runtime
    const { inngest } = await import('@synap/jobs');
    await inngest.send({
      name: 'api/event.logged',
      data: {
        id: event.id,
        type: event.type,
        aggregateId: event.aggregateId,
        aggregateType: 'entity',
        userId: event.userId,
        version: 1,
        timestamp: event.timestamp.toISOString(),
        data: event.data,
        metadata: { version: event.version, requestId: event.requestId, ...taskEventMetadata },
        source: event.source,
        causationId: event.causationId,
        correlationId: event.correlationId,
        requestId: event.requestId,
      },
    });

    logs.push(`Published task.creation.requested event ${eventRecord.id}.`);

    const resultPayload: CreateEntityPayload = {
      entityId,
      eventId: eventRecord.id,
      aggregateVersion: eventRecord.version,
    };

    return toExecutionResult(resultPayload, startedAt, logs);
  },
};

