/**
 * Notes Router - Thought Capture
 *
 * Provides simple note creation backed by event sourcing and R2 storage.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { requireUserId } from '../utils/user-scoped.js';
import { noteService } from '@synap/domain';
import { createLogger } from '@synap/core';

const notesLogger = createLogger({ module: 'notes-router' });

export const notesRouter = router({
  /**
   * Create a note
   *
   * This endpoint:
   * 1. Stores raw content in R2 + legacy content_blocks
   * 2. Emits a 'note.created' event to the event log
   * 3. Returns the created note metadata
   */
  create: protectedProcedure
    .input(
      z.object({
        content: z.string().min(1).describe('Note content'),
        inputType: z.enum(['text', 'audio']).default('text'),
        audioUrl: z.string().optional(),
        autoEnrich: z.boolean().default(true),
        tags: z.array(z.string()).optional(),
        useRAG: z.boolean().default(false).describe('Enable semantic search indexing'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const log = notesLogger.child({ userId });
      log.info('Creating note via API');

      const result = await noteService.createNote({
        userId,
        content: input.content,
        tags: input.tags,
        metadata: {
          inputType: input.inputType,
          audioUrl: input.audioUrl,
          autoEnrich: input.autoEnrich,
          useRAG: input.useRAG,
        },
      });

      log.info({ entityId: result.entityId }, 'Note created successfully');

      return {
        success: true,
        note: {
          id: result.entityId,
          title: result.title,
          preview: result.preview,
          tags: input.tags ?? [],
          metadata: {
            createdAt: result.createdAt.toISOString(),
            updatedAt: result.updatedAt.toISOString(),
          },
        },
        entityId: result.entityId,
        fileUrl: result.fileUrl,
      };
    }),

  /**
   * Search notes using Initiativ RAG
   */
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1),
        useRAG: z.boolean().default(false),
        limit: z.number().min(1).max(100).default(10),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      notesLogger.debug({ userId, query: input.query }, 'Searching notes via API');

      const results = await noteService.searchNotes({
        userId,
        query: input.query,
        limit: input.limit,
      });

      return results;
    }),
});

