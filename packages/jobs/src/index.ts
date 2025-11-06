/**
 * Jobs Package - Main Export
 */

export * from './client.js';
export { handleNewEvent } from './functions/projectors.js';
export { analyzeCapturedThought } from './functions/ai-analyzer.js';
export { processAnalyzedThought } from './functions/thought-processor.js';

// Export all functions for Inngest
import { handleNewEvent } from './functions/projectors.js';
import { analyzeCapturedThought } from './functions/ai-analyzer.js';
import { processAnalyzedThought } from './functions/thought-processor.js';

export const functions = [
  handleNewEvent,
  analyzeCapturedThought,
  processAnalyzedThought,
];

