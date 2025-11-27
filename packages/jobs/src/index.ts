/**
 * Jobs Package - Main Export
 * 
 * Phase 2: Worker Layer
 * 
 * This package exports:
 * - Event dispatcher (central Inngest function)
 * - Event handlers (registered automatically)
 * - Legacy functions (for backward compatibility)
 */

// Import handlers to register them (side effect)
import './handlers/index.js';

export * from './client.js';
export { handleNewEvent } from './functions/projectors.js';
export { analyzeCapturedThought } from './functions/ai-analyzer.js';
export { processAnalyzedThought } from './functions/thought-processor.js';
export { insightPatternDetector } from './functions/insights.js';
export { indexEntityEmbedding } from './functions/entity-embedding.js';

// Phase 2: Export event dispatcher and handlers
export { eventDispatcher } from './functions/event-dispatcher.js';
export * from './handlers/index.js';

// Export all functions for Inngest
import { handleNewEvent } from './functions/projectors.js';
import { analyzeCapturedThought } from './functions/ai-analyzer.js';
import { processAnalyzedThought } from './functions/thought-processor.js';
import { insightPatternDetector } from './functions/insights.js';
import { indexEntityEmbedding } from './functions/entity-embedding.js';
import { eventDispatcher } from './functions/event-dispatcher.js';
// Note: ingestionEngineV1 has been moved to synap-intelligence-hub repository
// import { ingestionEngineV1 } from './functions/ingestion-engine.js';

export const functions = [
  // Phase 2: Event dispatcher (replaces direct event handling)
  eventDispatcher,
  // Note: Ingestion Engine V1 is now in synap-intelligence-hub (proprietary)
  // ingestionEngineV1,
  // Legacy functions (kept for backward compatibility)
  handleNewEvent,
  analyzeCapturedThought,
  processAnalyzedThought,
  insightPatternDetector,
  indexEntityEmbedding,
];

