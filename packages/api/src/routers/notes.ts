/**
 * Notes Router - Phase 4: CQRS API Layer
 *
 * Commands (mutations): Publish events, return pending status
 * Queries: Read directly from projections
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { randomUUID } from 'crypto';
import { createSynapEvent, EventTypes } from '@synap/types';
import { getEventRepository } from '@synap/database';
import { publishEvent } from '../utils/inngest-client.js';
import { db, entities, eq, desc, and } from '@synap/database';
import { createLogger } from '@synap/core';

const notesLogger = createLogger({ module: 'notes-router' });

// ============================================================================
// INPUT SCHEMAS
// ============================================================================

const CreateNoteInputSchema = z.object({
  content: z.string().min(1).describe('Note content'),
  title: z.string().optional().describe('Optional note title'),
  tags: z.array(z.string()).optional().describe('Optional tags'),
});

const ListNotesInputSchema = z.object({
  limit: z.number().min(1).max(100).default(20),
  offset: z.number().min(0).default(0),
  type: z.enum(['note', 'task', 'all']).default('note'),
});

const GetNoteInputSchema = z.object({
  id: z.string().uuid(),
});

// ============================================================================
// ROUTER
// ============================================================================

export const notesRouter = router({
  /**
   * Create a note (Command)
   * 
   * Phase 4: CQRS Pattern
   * - Validates input
   * - Publishes note.creation.requested event
   * - Returns immediately with pending status
   * - NO business logic in API layer
   */
  create: protectedProcedure
    .input(CreateNoteInputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string; // Already validated by protectedProcedure
      const requestId = randomUUID();
      const entityId = randomUUID();
      const correlationId = randomUUID();

      notesLogger.info({ userId, requestId, entityId }, 'Publishing note.creation.requested event');

      // Create SynapEvent
      const event = createSynapEvent({
        type: EventTypes.NOTE_CREATION_REQUESTED,
        userId,
        aggregateId: entityId,
        data: {
          content: input.content,
          title: input.title,
          tags: input.tags,
        },
        source: 'api',
        requestId,
        correlationId,
      });

      // Append to Event Store
      const eventRepo = getEventRepository();
      await eventRepo.append(event);

      // Publish to Inngest (for async processing)
      await publishEvent('api/event.logged', {
        id: event.id,
        type: event.type,
        aggregateId: event.aggregateId,
        aggregateType: 'entity',
        userId: event.userId,
        version: 1,
        timestamp: event.timestamp.toISOString(),
        data: event.data,
        metadata: { version: event.version, requestId: event.requestId },
        source: event.source,
        causationId: event.causationId,
        correlationId: event.correlationId,
        requestId: event.requestId,
      }, userId);

      // Return immediately with pending status
      return {
        success: true,
        status: 'pending' as const,
        requestId,
        entityId,
        message: 'Note creation request received. Processing asynchronously.',
      };
    }),

  /**
   * List notes (Query)
   * 
   * Phase 4: CQRS Pattern
   * - Reads directly from projections (entities table)
   * - No events generated
   * - Fast, optimized queries
   * - RLS ensures user isolation
   */
  list: protectedProcedure
    .input(ListNotesInputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId as string;
      
      notesLogger.debug({ userId, limit: input.limit, offset: input.offset }, 'Listing notes from projection');

      // Read directly from projection (entities table)
      // RLS automatically filters by userId
      
      let whereCondition: any;
      if (input.type === 'all') {
        whereCondition = eq(entities.userId, userId) as any;
      } else {
        whereCondition = and(
          eq(entities.userId, userId) as any,
          eq(entities.type, input.type) as any
        ) as any;
      }
      
      const query = db
        .select()
        .from(entities)
        .where(whereCondition)
        .orderBy(desc(entities.createdAt) as any)
        .limit(input.limit)
        .offset(input.offset);

      const rows = await query;

      return {
        notes: rows.map((row: any) => ({
          id: row.id,
          title: row.title,
          preview: row.preview,
          type: row.type,
          fileUrl: row.fileUrl,
          filePath: row.filePath,
          fileSize: row.fileSize,
          fileType: row.fileType,
          createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
          updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt).toISOString(),
        })),
        total: rows.length,
        limit: input.limit,
        offset: input.offset,
      };
    }),

  /**
   * Get note by ID (Query)
   * 
   * Phase 4: CQRS Pattern
   * - Reads directly from projection
   * - RLS ensures user can only access their own notes
   */
  getById: protectedProcedure
    .input(GetNoteInputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.userId as string;

      notesLogger.debug({ userId, noteId: input.id }, 'Getting note from projection');

      // Read directly from projection
      // RLS ensures user can only access their own notes
      const rows = await db
        .select()
        .from(entities)
        .where(eq(entities.id, input.id) as any)
        .limit(1);

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0] as any;

      // Verify user owns this note (RLS should handle this, but double-check for safety)
      if (row.userId !== userId) {
        notesLogger.warn({ userId, noteId: input.id, noteUserId: row.userId }, 'User attempted to access another user\'s note');
        return null;
      }

      return {
        id: row.id,
        title: row.title,
        preview: row.preview,
        type: row.type,
        fileUrl: row.fileUrl,
        filePath: row.filePath,
        fileSize: row.fileSize,
        fileType: row.fileType,
        checksum: row.checksum,
        createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString(),
        updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : new Date(row.updatedAt).toISOString(),
      };
    }),

  /**
   * Search notes (Query)
   * 
   * Phase 4: CQRS Pattern
   * - Uses existing search service (which reads from projections)
   * - No events generated
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
      const userId = ctx.userId as string;
      
      // For now, use existing search service
      // In future, this could be optimized to read directly from projections
      const { noteService } = await import('@synap/domain');
      const results = await noteService.searchNotes({
        userId,
        query: input.query,
        limit: input.limit,
      });

      return results;
    }),
});

