/**
 * Initiativ Core Adapter for Synap Backend
 * 
 * Bridges @initiativ/core workflows with Synap's event-sourced architecture.
 * 
 * Flow:
 * 1. User calls tRPC endpoint
 * 2. Adapter calls @initiativ/core workflow
 * 3. Workflow results are converted to Synap events
 * 4. Events are logged via event router
 */

import { InitiativCore, Workflows } from '@initiativ/core';
import type { Note } from '@initiativ/storage';
import type { CoreConfig } from '@initiativ/core';

/**
 * Initialize Initiativ Core for Synap
 * 
 * Multi-user support:
 * - SQLite: userId defaults to 'local-user' (single-user)
 * - PostgreSQL: userId comes from authenticated session (multi-user)
 */
export function createInitiativCore(config: {
  dataPath: string;
  anthropicApiKey: string;
  enableRAG?: boolean;
  userId?: string; // NEW: Optional userId for multi-user mode
}): InitiativCore {
  const coreConfig: CoreConfig = {
    dataPath: config.dataPath,
    userId: config.userId || 'local-user', // Fallback to 'local-user' for SQLite
    agentApiKey: config.anthropicApiKey,
    agentModel: 'claude-3-haiku-20240307',
    // Only provide embeddings config if RAG is enabled
    embeddingsApiKey: config.enableRAG ? (process.env.EMBEDDINGS_API_KEY || process.env.OPENAI_API_KEY) : undefined,
    embeddingsProvider: config.enableRAG ? (process.env.EMBEDDINGS_PROVIDER as any || 'openai') : 'openai',
    autoRebuildCache: false, // We'll use Drizzle projections instead
    autoCommitEnabled: false, // Git versioning can be Phase 2
  };

  return new InitiativCore(coreConfig);
}

/**
 * Convert Initiativ Note to Synap Entity + ContentBlock event data
 */
export function noteToEntityEvent(note: Note): {
  entityId: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
} {
  return {
    entityId: note.id,
    type: 'note', // Can be enhanced to detect task/event/etc from note content
    title: note.title,
    content: note.content,
    tags: note.tags || [],
    metadata: {
      ...note.metadata,
      createdAt: note.createdAt.toISOString(),
      updatedAt: note.updatedAt.toISOString(),
      gitCommitHash: note.gitCommitHash,
    },
  };
}

/**
 * Create a note using Initiativ workflow and emit Synap event
 * 
 * This adapter:
 * 1. Uses @initiativ/core to process input and create note
 * 2. Converts note to Synap event format
 * 3. Returns event data (caller should log it via events.log)
 * 
 * Multi-user support:
 * - userId is passed to Workflows (optional for SQLite, required for PostgreSQL)
 * - RLS automatically filters database queries by userId
 */
export async function createNoteViaInitiativ(
  core: InitiativCore,
  input: { type: 'text' | 'audio'; content: string; audioUrl?: string },
  options?: { autoEnrich?: boolean; tags?: string[]; userId?: string }
): Promise<Note> {
  // Ensure core is initialized
  await core.init();

  // Create workflows instance with optional userId
  const workflows = new Workflows(core, options?.userId);

  // Use Initiativ's input router to process
  // For now, only support text input (audio would need Buffer data)
  const inputObj = { type: 'text' as const, data: input.content };

  // Call the captureNote workflow
  const note = await workflows.captureNote(inputObj, {
    autoEnrich: options?.autoEnrich ?? true,
    tags: options?.tags,
  });

  return note;
}

