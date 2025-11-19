import { randomUUID } from 'node:crypto';
import { db, entities } from '@synap/database';
import { storage, type IFileStorage } from '@synap/storage';
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

// Schema for note metadata validation (currently unused but kept for future use)
// const noteMetadataSchema = z.object({
//   entityId: z.string().uuid(),
//   type: z.literal('note'),
//   title: z.string(),
//   content: z.string(),
//   tags: z.array(z.string()).default([]),
//   fileUrl: z.string().nullable(),
//   filePath: z.string().nullable(),
// });

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
    private readonly fileStorage: IFileStorage = storage
  ) {}

  /**
   * @deprecated V0.6: This method is deprecated. Notes should be created via event-driven flow.
   * Use `note.creation.requested` event instead. This method is kept for backward compatibility only.
   * 
   * Note: This method no longer emits events. Events are handled by NoteCreationHandler worker.
   */
  async createNote(input: CreateNoteInput): Promise<CreateNoteResult> {
    const parsed = CreateNoteInputSchema.parse(input);
    const entityId = parsed.entityId ?? randomUUID();
    const createdAt = new Date();
    const title = buildTitle(parsed.title, parsed.content);
    const preview = parsed.content.slice(0, 500);
    const tags = parsed.tags ?? [];
    const log = notesLogger.child({ userId: parsed.userId, entityId });

    log.info({ tags: tags.length }, 'Creating note');

    const storagePath = this.fileStorage.buildPath(parsed.userId, 'note', entityId, 'md');
    const fileMetadata = await this.fileStorage.upload(storagePath, parsed.content, {
      contentType: 'text/markdown',
    });

    log.debug({ storagePath: fileMetadata.path, size: fileMetadata.size }, 'Uploaded note content to storage');

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

    // V0.6: NoteService.createNote() is deprecated
    // Notes should be created via event-driven flow (note.creation.requested event)
    // This method is kept for backward compatibility but should not emit events
    // Events are now handled by NoteCreationHandler worker
    
    // Generate a synthetic event ID for backward compatibility
    const syntheticEventId = randomUUID();

    log.warn({ entityId }, 'NoteService.createNote() is deprecated. Use event-driven flow instead.');

    return CreateNoteResultSchema.parse({
      entityId,
      eventId: syntheticEventId, // Synthetic ID for backward compatibility
      aggregateVersion: 1,
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


