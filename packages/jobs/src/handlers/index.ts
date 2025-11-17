/**
 * Event Handlers - Phase 2: Worker Layer
 * 
 * Exports all event handlers and registers them with the handler registry.
 * 
 * This file is imported by the jobs package index to ensure handlers
 * are registered when the module loads.
 */

import { handlerRegistry } from './registry.js';
import { NoteCreationHandler } from './note-creation-handler.js';
import { EmbeddingGeneratorHandler } from './embedding-generator-handler.js';

// Create handler instances
const noteCreationHandler = new NoteCreationHandler();
const embeddingGeneratorHandler = new EmbeddingGeneratorHandler();

// Register handlers
handlerRegistry.register(noteCreationHandler);
handlerRegistry.register(embeddingGeneratorHandler);

// Export handlers for testing/debugging
export { NoteCreationHandler, EmbeddingGeneratorHandler };
export { handlerRegistry } from './registry.js';
export type { IEventHandler, InngestStep, HandlerResult } from './interface.js';

