/**
 * Notes Router - Thought Capture with Initiativ Integration
 * 
 * This router uses @initiativ/core workflows for business logic,
 * but emits Synap events for state management.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { events } from '@synap/database';
import { createInitiativCore, createNoteViaInitiativ, noteToEntityEvent } from '../adapters/initiativ-adapter.js';
import { Workflows } from '@initiativ/core';
import path from 'path';
import os from 'os';

// Initialize Initiativ Core (singleton for now)
let initiativCore: ReturnType<typeof createInitiativCore> | null = null;

function getInitiativCore(enableRAG: boolean = false) {
  // Reset core if RAG setting changes
  if (initiativCore && enableRAG !== (initiativCore.rag !== undefined)) {
    initiativCore = null;
  }

  if (!initiativCore) {
    const dataPath = process.env.DATA_PATH || path.join(os.homedir(), '.synap', 'data');
    const anthropicKey = process.env.ANTHROPIC_API_KEY || '';

    if (!anthropicKey) {
      throw new Error('ANTHROPIC_API_KEY is required');
    }

    initiativCore = createInitiativCore({
      dataPath,
      anthropicApiKey: anthropicKey,
      enableRAG,
    });
  }
  return initiativCore;
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
      const core = getInitiativCore(input.useRAG);
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
        }
      );

      // Step 2: Convert to Synap event format
      const eventData = noteToEntityEvent(note);

      // Step 3: Emit event to event log
      await ctx.db.insert(events).values({
        type: 'entity.created',
        data: eventData,
        source: 'api',
      });

      return {
        success: true,
        note,
        entityId: eventData.entityId,
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
    .query(async ({ input }) => {
      const core = getInitiativCore();
      await core.init();

      // Use Initiativ's search workflow
      const workflows = new Workflows(core);
      const results = await workflows.searchNotes(input.query, {
        useRAG: input.useRAG,
        limit: input.limit,
      });

      return results;
    }),
});

