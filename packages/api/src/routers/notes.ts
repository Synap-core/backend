/**
 * Notes Router - Thought Capture with Initiativ Integration
 * 
 * This router uses @initiativ/core workflows for business logic,
 * but emits Synap events for state management.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { events, entities, contentBlocks } from '@synap/database';
import { createInitiativCore, createNoteViaInitiativ, noteToEntityEvent } from '../adapters/initiativ-adapter.js';
import { Workflows } from '@initiativ/core';
import { requireUserId } from '../utils/user-scoped.js';
import { r2, R2Storage } from '@synap/storage';
import path from 'path';
import os from 'os';

// Initialize Initiativ Core (singleton for now, but scoped per user)
const initiativCores = new Map<string, ReturnType<typeof createInitiativCore>>();

function getInitiativCore(userId?: string, enableRAG: boolean = false) {
  const coreKey = `${userId || 'local-user'}-${enableRAG}`;
  
  // Return existing core if available
  if (initiativCores.has(coreKey)) {
    return initiativCores.get(coreKey)!;
  }

  // Create new core
  const dataPath = process.env.DATA_PATH || path.join(os.homedir(), '.synap', 'data');
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

  if (!anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY is required');
  }

  const core = createInitiativCore({
    dataPath,
    anthropicApiKey: anthropicKey,
    enableRAG,
    userId, // Pass userId for multi-user mode
  });

  initiativCores.set(coreKey, core);
  return core;
}

export const notesRouter = router({
  /**
   * Create a note using Initiativ workflow
   * 
   * This endpoint:
   * 1. Uses @initiativ/core to process and enrich the note
   * 2. Emits a 'note.created' event to the event log
   * 3. Returns the created note
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
      
      // Get user-scoped Initiativ Core
      const core = getInitiativCore(userId, input.useRAG);
      await core.init(); // Initialize if not already done

      // Step 1: Create note using Initiativ workflow
      const note = await createNoteViaInitiativ(
        core,
        {
          type: input.inputType,
          content: input.content,
          audioUrl: input.audioUrl,
        },
        {
          autoEnrich: input.autoEnrich,
          tags: input.tags,
          userId, // Pass userId for multi-user mode
        }
      );

      // Step 2: Convert to Synap event format
      const eventData = noteToEntityEvent(note);

      // ============================================================
      // V0.3 DUAL-WRITE: Write to BOTH R2 AND PostgreSQL
      // ============================================================
      
      // 2a. Upload to R2 (NEW!)
      const r2Path = R2Storage.buildPath(userId, 'note', eventData.entityId, 'md');
      const r2Upload = await r2.upload(
        r2Path,
        input.content,
        { contentType: 'text/markdown' }
      );

      console.log('✅ [V0.3] Uploaded to R2:', {
        entityId: eventData.entityId,
        fileUrl: r2Upload.url,
        fileSize: r2Upload.size,
        checksum: r2Upload.checksum,
      });

      // 2b. Still write to content_blocks (OLD - for validation)
      await ctx.db.insert(contentBlocks).values({
        entityId: eventData.entityId,
        content: input.content,
        contentType: 'markdown',
      });

      console.log('✅ [V0.3] Wrote to content_blocks (legacy)');

      // 2c. Create entity with file reference
      await ctx.db.insert(entities).values({
        id: eventData.entityId,
        userId,
        type: 'note',
        title: note.title || 'Untitled',
        preview: input.content.substring(0, 500),
        fileUrl: r2Upload.url,
        filePath: r2Upload.path,
        fileSize: r2Upload.size,
        fileType: 'markdown',
        checksum: r2Upload.checksum,
        version: 1,
      });

      console.log('✅ [V0.3] Created entity with file reference');

      // Step 3: Emit event to event log with userId
      await ctx.db.insert(events).values({
        type: 'entity.created',
        data: { 
          ...eventData, 
          userId,
          fileUrl: r2Upload.url,  // Include file reference in event
        },
        source: 'api',
        userId, // ✅ User isolation
      });

      console.log('✅ [V0.3] Dual-write complete!', {
        entityId: eventData.entityId,
        r2: r2Upload.url,
        postgres: 'content_blocks',
      });

      return {
        success: true,
        note,
        entityId: eventData.entityId,
        fileUrl: r2Upload.url, // Return R2 URL
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
      const userId = ctx.userId || undefined; // Convert null to undefined
      
      // Get user-scoped Initiativ Core
      const core = getInitiativCore(userId, input.useRAG);
      await core.init();

      // Use Initiativ's search workflow
      const workflows = new Workflows(core, userId);
      const results = await workflows.searchNotes(input.query, {
        useRAG: input.useRAG,
        limit: input.limit,
      });

      return results;
    }),
});

