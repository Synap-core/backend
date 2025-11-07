import { randomUUID } from 'node:crypto';
import { eventService, noteService } from '@synap/domain';
import { z } from 'zod';
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

interface EventDataPayload extends Record<string, unknown> {
  entityId: string;
  type: 'note' | 'task';
  title: string;
  preview?: string;
  fileUrl?: string;
  filePath?: string;
  fileSize?: number;
  fileType?: string;
  checksum?: string;
  dueDate?: string;
}

const ensureNoteContent = (type: 'note' | 'task', content?: string) => {
  if (type === 'note' && (!content || content.trim().length === 0)) {
    throw new Error('Note creation requires non-empty content.');
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

    logs.push(`Generated entityId ${entityId}`);

    if (input.type === 'note') {
      const noteResult = await noteService.createNote({
        userId: context.userId,
        content: input.content ?? '',
        title: input.title,
        tags: input.tags,
        source: 'automation',
        metadata: {
          orchestrator: 'synap-agent',
          tool: 'createEntity',
          threadId: context.threadId,
        },
      });

      logs.push(`Created note ${noteResult.entityId} via NoteService.`);

      const resultPayload: CreateEntityPayload = {
        entityId: noteResult.entityId,
        eventId: noteResult.eventId,
        aggregateVersion: noteResult.aggregateVersion,
        fileUrl: noteResult.fileUrl ?? undefined,
        filePath: noteResult.filePath ?? undefined,
        fileSize: noteResult.fileSize ?? undefined,
        fileChecksum: noteResult.checksum ?? undefined,
      };

      return toExecutionResult(resultPayload, startedAt, logs);
    }

    const preview = input.preview ?? input.content?.slice(0, 500);

    const eventData: EventDataPayload = {
      entityId,
      type: 'task',
      title: input.title,
      preview,
      dueDate: input.dueDate,
    };

    const eventRecord = await eventService.append({
      aggregateId: eventData.entityId,
      aggregateType: 'entity',
      eventType: 'entity.created',
      userId: context.userId,
      data: eventData,
      metadata: {
        orchestrator: 'synap-agent',
        tool: 'createEntity',
        threadId: context.threadId,
      },
      version: 1,
      source: 'automation',
    });

    logs.push(`Appended task creation event ${eventRecord.id}.`);

    const resultPayload: CreateEntityPayload = {
      entityId,
      eventId: eventRecord.id,
      aggregateVersion: eventRecord.version,
    };

    return toExecutionResult(resultPayload, startedAt, logs);
  },
};

