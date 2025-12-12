/**
 * Jobs Package - Main Export
 * 
 * Phase 4: Schema-Driven Event Architecture
 * 
 * This package exports:
 * - Consolidated table-based workers (entities, documents, messages)
 * - Shared workers (embeddings, webhooks, AI)
 * - Legacy projectors (will be phased out)
 */

export * from './client.js';

// ============================================================================
// NEW: Consolidated Table-Based Workers
// ============================================================================
export { entitiesWorker } from './functions/entities.js';
export { documentsWorker } from './functions/documents.js';
export { messagesWorker } from './functions/messages.js';

// ============================================================================
// KEPT: Shared/Cross-Cutting Workers
// ============================================================================
export { handleNewEvent } from './functions/projectors.js';
export { analyzeCapturedThought } from './functions/ai-analyzer.js';
export { processAnalyzedThought } from './functions/thought-processor.js';
export { insightPatternDetector } from './functions/insights.js';
export { indexEntityEmbedding } from './functions/entity-embedding.js';
export { handleWebhookDelivery } from './functions/webhook-broker.js';

// ============================================================================
// DEPRECATED: Legacy entity-specific workers (kept for backward compat)
// TODO: Remove in v2.0 after migration is complete
// ============================================================================
export { handleTaskCreation } from './functions/task-creation.js';
export { handleNoteCreation } from './functions/note-creation.js';
export { handleConversationMessage } from './functions/conversation-message.js';
export { handleProjectCreation } from './functions/project-creation.js';
export { handleTaskCompletion } from './functions/task-completion.js';
export { handleEmbeddingGeneration } from './functions/embedding-generation.js';
export { contentCreationFunction } from './functions/content-creation.js';

// ============================================================================
// INNGEST FUNCTION REGISTRY
// ============================================================================

// New consolidated workers
import { entitiesWorker } from './functions/entities.js';
import { documentsWorker } from './functions/documents.js';
import { messagesWorker } from './functions/messages.js';

// Shared workers
import { handleNewEvent } from './functions/projectors.js';
import { analyzeCapturedThought } from './functions/ai-analyzer.js';
import { processAnalyzedThought } from './functions/thought-processor.js';
import { insightPatternDetector } from './functions/insights.js';
import { indexEntityEmbedding } from './functions/entity-embedding.js';
import { handleWebhookDelivery } from './functions/webhook-broker.js';

// Legacy workers (deprecated)
import { handleTaskCreation } from './functions/task-creation.js';
import { handleNoteCreation } from './functions/note-creation.js';
import { handleConversationMessage } from './functions/conversation-message.js';
import { handleProjectCreation } from './functions/project-creation.js';
import { handleTaskCompletion } from './functions/task-completion.js';
import { handleEmbeddingGeneration } from './functions/embedding-generation.js';
import { contentCreationFunction } from './functions/content-creation.js';

/**
 * All Inngest functions to register with the serve handler.
 * 
 * Order: New consolidated → Shared → Legacy
 */
export const functions = [
  // NEW: Consolidated table-based workers (Phase 4)
  entitiesWorker,
  documentsWorker,
  messagesWorker,
  
  // KEPT: Shared/cross-cutting workers
  handleNewEvent,
  analyzeCapturedThought,
  processAnalyzedThought,
  insightPatternDetector,
  indexEntityEmbedding,
  handleWebhookDelivery,
  
  // DEPRECATED: Legacy workers (remove after migration)
  // These are kept for backward compatibility during transition
  handleTaskCreation,
  handleNoteCreation,
  handleConversationMessage,
  handleProjectCreation,
  handleTaskCompletion,
  handleEmbeddingGeneration,
  contentCreationFunction,
];

/**
 * New consolidated functions only (for Phase 4 testing)
 */
export const consolidatedFunctions = [
  entitiesWorker,
  documentsWorker,
  messagesWorker,
];
