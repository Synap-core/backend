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
import { ConversationMessageHandler } from './conversation-message-handler.js';
import { TaskCreationHandler } from './task-creation-handler.js';
import { TaskCompletionHandler } from './task-completion-handler.js';
import { ProjectCreationHandler } from './project-creation-handler.js';

// Create handler instances
const noteCreationHandler = new NoteCreationHandler();
// NOTE: These handlers are disabled as they use @synap/ai which has been moved to synap-intelligence-hub
// const embeddingGeneratorHandler = new EmbeddingGeneratorHandler();
// const conversationMessageHandler = new ConversationMessageHandler();
const taskCreationHandler = new TaskCreationHandler();
const taskCompletionHandler = new TaskCompletionHandler();
const projectCreationHandler = new ProjectCreationHandler();

// Register handlers
handlerRegistry.register(noteCreationHandler);
// NOTE: Embedding and conversation handlers disabled - use Intelligence Hub via Hub Protocol
// handlerRegistry.register(embeddingGeneratorHandler);
// handlerRegistry.register(conversationMessageHandler);
handlerRegistry.register(taskCreationHandler);
handlerRegistry.register(taskCompletionHandler);
handlerRegistry.register(projectCreationHandler);

// Export handlers for testing/debugging
export { 
  NoteCreationHandler, 
  EmbeddingGeneratorHandler, 
  ConversationMessageHandler,
  TaskCreationHandler,
  TaskCompletionHandler,
  ProjectCreationHandler,
};
export { handlerRegistry } from './registry.js';
export type { IEventHandler, InngestStep, HandlerResult } from './interface.js';

