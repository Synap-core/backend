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
import { requireUserId } from '../utils/user-scoped.js';
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

      // Step 3: Emit event to event log with userId
      await ctx.db.insert(events).values({
        type: 'entity.created',
        data: { ...eventData, userId }, // ✅ Include userId in event data
        source: 'api',
        userId, // ✅ User isolation
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

