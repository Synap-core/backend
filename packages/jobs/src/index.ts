/**
 * Jobs Package - Main Export
 * 
 * Phase 3: Refactored Handler Architecture
 * 
 * This package exports:
 * - Handler functions (Inngest functions with direct event subscriptions)
 * - Legacy functions (for backward compatibility)
 */

export * from './client.js';
export { handleNewEvent } from './functions/projectors.js';
export { analyzeCapturedThought } from './functions/ai-analyzer.js';
export { processAnalyzedThought } from './functions/thought-processor.js';
export { insightPatternDetector } from './functions/insights.js';
export { indexEntityEmbedding } from './functions/entity-embedding.js';

// Export new handler functions
export { handleTaskCreation } from './functions/task-creation.js';
export { handleNoteCreation } from './functions/note-creation.js';
export { handleConversationMessage } from './functions/conversation-message.js';
export { handleProjectCreation } from './functions/project-creation.js';
export { handleTaskCompletion } from './functions/task-completion.js';
export { handleEmbeddingGeneration } from './functions/embedding-generation.js';
export { handleWebhookDelivery } from './functions/webhook-broker.js';

// Import all functions for Inngest
import { handleNewEvent } from './functions/projectors.js';
import { analyzeCapturedThought } from './functions/ai-analyzer.js';
import { processAnalyzedThought } from './functions/thought-processor.js';
import { insightPatternDetector } from './functions/insights.js';
import { indexEntityEmbedding } from './functions/entity-embedding.js';
import { handleTaskCreation } from './functions/task-creation.js';
import { handleNoteCreation } from './functions/note-creation.js';
import { handleConversationMessage } from './functions/conversation-message.js';
import { handleProjectCreation } from './functions/project-creation.js';
import { handleTaskCompletion } from './functions/task-completion.js';
import { handleEmbeddingGeneration } from './functions/embedding-generation.js';
import { handleWebhookDelivery } from './functions/webhook-broker.js';

export const functions = [
  // Legacy functions (kept for backward compatibility)
  handleNewEvent,
  analyzeCapturedThought,
  processAnalyzedThought,
  insightPatternDetector,
  indexEntityEmbedding,
  
  // Phase 3: Direct event subscription handlers
  handleTaskCreation,
  handleNoteCreation,
  handleConversationMessage,
  handleProjectCreation,
  handleTaskCompletion,
  handleEmbeddingGeneration,
  handleWebhookDelivery,
];
