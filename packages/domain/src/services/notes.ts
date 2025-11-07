import { randomUUID } from 'node:crypto';
import { db, entities, contentBlocks } from '@synap/database';
import { r2, R2Storage } from '@synap/storage';
import { z } from 'zod';
import { createLogger } from '@synap/core';
import {
  CreateNoteInputSchema,
  CreateNoteResultSchema,
  SearchNotesInputSchema,
  type CreateNoteInput,
  type CreateNoteResult,
  type NoteSearchResult,
  type SearchNotesInput,
} from '../types.js';
import { eventService } from './events.js';

const noteMetadataSchema = z.object({
  entityId: z.string().uuid(),
  type: z.literal('note'),
  title: z.string(),
  content: z.string(),
  tags: z.array(z.string()).default([]),
  fileUrl: z.string().nullable(),
  filePath: z.string().nullable(),
});

const buildTitle = (explicitTitle: string | undefined, content: string): string => {
  if (explicitTitle && explicitTitle.trim().length > 0) {
    return explicitTitle.trim();
  }

  const firstLine = content.split('\n')[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : 'Untitled';
};

const optionalUserId = (userId: string): Record<string, string> => {
  const entitySchema = entities as unknown as { userId?: unknown };
  return 'userId' in entitySchema ? { userId } : {};
};

const notesLogger = createLogger({ module: 'note-service' });

export class NoteService {
  constructor(
    private readonly database: typeof db = db,
    private readonly storage: typeof r2 = r2
  ) {}

  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const parsed = CreateNoteInputSchema.parse(input);
    const entityId = parsed.entityId ?? randomUUID();
    const createdAt = new Date();
    const title = buildTitle(parsed.title, parsed.content);
    const preview = parsed.content.slice(0, 500);
    const tags = parsed.tags ?? [];
    const log = notesLogger.child({ userId: parsed.userId, entityId });

    log.info({ tags: tags.length }, 'Creating note');

    const storagePath = R2Storage.buildPath(parsed.userId, 'note', entityId, 'md');
    const fileMetadata = await this.storage.upload(storagePath, parsed.content, {
      contentType: 'text/markdown',
    });

    log.debug({ storagePath: fileMetadata.path, size: fileMetadata.size }, 'Uploaded note content to storage');

    await this.database.insert(contentBlocks).values({
      entityId,
      content: parsed.content,
      contentType: 'markdown',
    });

    await this.database.insert(entities).values({
      id: entityId,
      ...optionalUserId(parsed.userId),
      type: 'note',
      title,
      preview,
      fileUrl: fileMetadata.url,
      filePath: fileMetadata.path,
      fileSize: fileMetadata.size,
      fileType: 'markdown',
      checksum: fileMetadata.checksum,
      version: 1,
      createdAt,
      updatedAt: createdAt,
    } as any);

    log.debug('Entity projection inserted');

    const metadataPayload = noteMetadataSchema.parse({
      entityId,
      type: 'note',
      title,
      content: parsed.content,
      tags,
      fileUrl: fileMetadata.url,
      filePath: fileMetadata.path,
    });

    const eventRecord = await eventService.append({
      aggregateId: entityId,
      aggregateType: 'entity',
      eventType: 'entity.created',
      userId: parsed.userId,
      data: metadataPayload,
      metadata: parsed.metadata,
      version: 1,
      source: parsed.source,
    });

    log.info({ eventId: eventRecord.id }, 'Note creation event appended');

    return CreateNoteResultSchema.parse({
      entityId,
      eventId: eventRecord.id,
      aggregateVersion: eventRecord.version,
      title,
      preview,
      fileUrl: fileMetadata.url,
      filePath: fileMetadata.path,
      fileSize: fileMetadata.size,
      fileType: 'markdown',
      checksum: fileMetadata.checksum,
      tags,
      createdAt,
      updatedAt: createdAt,
    });
  }

  async searchNotes(input: SearchNotesInput): Promise<NoteSearchResult[]> {
    const parsed = SearchNotesInputSchema.parse(input);

    notesLogger.debug({ userId: parsed.userId, query: parsed.query }, 'Searching notes');

    const rows = await this.database.select().from(entities).limit(200);

    const loweredQuery = parsed.query.toLowerCase();

    const matches = rows
      .filter((row: any) => {
        if (row.type !== 'note') {
          return false;
        }

        if ('userId' in row && row.userId !== parsed.userId) {
          return false;
        }

        return true;
      })
      .filter((row: any) => {
        const title = (row.title || '').toLowerCase();
        const preview = (row.preview || '').toLowerCase();
        return title.includes(loweredQuery) || preview.includes(loweredQuery);
      })
      .slice(0, parsed.limit);

    return matches.map((row: any) => ({
      id: row.id,
      title: row.title,
      preview: row.preview,
      fileUrl: row.fileUrl,
      fileType: row.fileType,
      tags: [],
    }));
  }
}

export const noteService = new NoteService();


