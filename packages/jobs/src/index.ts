/**
 * Jobs Package - Main Export
 */

export * from './client.js';
export { handleNewEvent } from './functions/projectors.js';
export { analyzeCapturedThought } from './functions/ai-analyzer.js';
export { processAnalyzedThought } from './functions/thought-processor.js';
export { insightPatternDetector } from './functions/insights.js';
export { indexEntityEmbedding } from './functions/entity-embedding.js';

// Export all functions for Inngest
import { handleNewEvent } from './functions/projectors.js';
import { analyzeCapturedThought } from './functions/ai-analyzer.js';
import { processAnalyzedThought } from './functions/thought-processor.js';
import { insightPatternDetector } from './functions/insights.js';
import { indexEntityEmbedding } from './functions/entity-embedding.js';

export const functions = [
  handleNewEvent,
  analyzeCapturedThought,
  processAnalyzedThought,
  insightPatternDetector,
  indexEntityEmbedding,
];

