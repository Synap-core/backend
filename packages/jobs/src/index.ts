/**
 * Jobs Package - Main Export
 * 
 * V2.0: Simplified Schema-Driven Event Architecture
 * 
 * This package exports:
 * - Table workers (entities, documents, messages)
 * - AI workers (analyzer, embeddings, insights)
 * - Shared workers (webhooks)
 * - Worker registry for admin UI
 */

export * from './client.js';
export * from './worker-registry.js';

// ============================================================================
// Table Workers
// ============================================================================
export { entitiesWorker } from './functions/entities.js';
export { documentsWorker } from './functions/documents.js';
export { messagesWorker } from './functions/messages.js';

// ============================================================================
// AI Workers
// ============================================================================
export { analyzeCapturedThought } from './functions/ai-analyzer.js';
export { processAnalyzedThought } from './functions/thought-processor.js';
export { insightPatternDetector } from './functions/insights.js';
export { indexEntityEmbedding } from './functions/entity-embedding.js';

// ============================================================================
// Shared Workers
// ============================================================================
export { handleNewEvent } from './functions/projectors.js';
export { handleWebhookDelivery } from './functions/webhook-broker.js';

// ============================================================================
// INNGEST FUNCTION REGISTRY
// ============================================================================

import { entitiesWorker } from './functions/entities.js';
import { documentsWorker } from './functions/documents.js';
import { messagesWorker } from './functions/messages.js';
import { handleNewEvent } from './functions/projectors.js';
import { analyzeCapturedThought } from './functions/ai-analyzer.js';
import { processAnalyzedThought } from './functions/thought-processor.js';
import { insightPatternDetector } from './functions/insights.js';
import { indexEntityEmbedding } from './functions/entity-embedding.js';
import { handleWebhookDelivery } from './functions/webhook-broker.js';

/**
 * All Inngest functions to register with the serve handler.
 */
export const functions = [
  // Table workers
  entitiesWorker,
  documentsWorker,
  messagesWorker,
  
  // AI workers
  analyzeCapturedThought,
  processAnalyzedThought,
  insightPatternDetector,
  indexEntityEmbedding,
  
  // Shared workers
  handleNewEvent,
  handleWebhookDelivery,
];
