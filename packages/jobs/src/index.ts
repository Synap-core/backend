/**
 * Jobs Package - Main Export
 * 
 * V2.0: Simplified Schema-Driven Event Architecture
 * 
 * This package exports:
 * - Table workers (entities, documents, messages, relations, workspaces, members)
 * - AI workers (analyzer, embeddings, insights)
 * - Shared workers (webhooks, permissions)
 * - Worker registry for admin UI
 */

export * from './client.js';
export * from './worker-registry.js';
export * from './utils/realtime-broadcast.js';

// ============================================================================
// Table Workers
// ============================================================================
export { entitiesWorker } from './functions/entities.js';
export { documentsWorker } from './functions/documents.js';
export { messagesWorker } from './functions/messages.js';
export { relationsWorker } from './functions/relations.js';
export { workspacesWorker } from './functions/workspaces.js';
export { workspaceMembersWorker } from './functions/workspace-members.js';
export { whiteboardSnapshotWorker, whiteboardRestoreWorker, whiteboardAutoSaveWorker } from './functions/whiteboard-snapshots.js';
export { documentSnapshotWorker, documentRestoreWorker, documentAutoSaveWorker } from './functions/document-snapshots.js';
export { documentPersistenceWorker } from './functions/document-persistence.js';

// ============================================================================
// AI Workers
// ============================================================================
export { analyzeCapturedThought } from './functions/ai-analyzer.js';
export { processAnalyzedThought } from './functions/thought-processor.js';
export { entityEmbeddingWorker } from './functions/entity-embedding.js';

// ============================================================================
// Shared Workers
// ============================================================================
export { handleNewEvent } from './functions/projectors.js';
export { handleWebhookDelivery } from './functions/webhook-broker.js';
export { globalValidator } from './functions/global-validator.js';

// ============================================================================
// INNGEST FUNCTION REGISTRY
// ============================================================================

import { entitiesWorker } from './functions/entities.js';
import { documentsWorker } from './functions/documents.js';
import { messagesWorker } from './functions/messages.js';
import { relationsWorker } from './functions/relations.js';
import { workspacesWorker } from './functions/workspaces.js';
import { workspaceMembersWorker } from './functions/workspace-members.js';
import { whiteboardSnapshotWorker, whiteboardRestoreWorker, whiteboardAutoSaveWorker } from './functions/whiteboard-snapshots.js';
import { documentSnapshotWorker, documentRestoreWorker, documentAutoSaveWorker } from './functions/document-snapshots.js';
import { documentPersistenceWorker } from './functions/document-persistence.js';
import { handleNewEvent } from './functions/projectors.js';
import { analyzeCapturedThought } from './functions/ai-analyzer.js';
import { processAnalyzedThought } from './functions/thought-processor.js';
import { entityEmbeddingWorker } from './functions/entity-embedding.js';
import { handleWebhookDelivery } from './functions/webhook-broker.js';
import { globalValidator } from './functions/global-validator.js';

/**
 * All Inngest functions to register with the serve handler.
 */
export const functions = [
  // Table workers
  entitiesWorker,
  documentsWorker,
  messagesWorker,
  relationsWorker,
  workspacesWorker,
  workspaceMembersWorker,
  whiteboardSnapshotWorker,
  whiteboardRestoreWorker,
  whiteboardAutoSaveWorker,
  documentSnapshotWorker,
  documentRestoreWorker,
  documentAutoSaveWorker,
  documentPersistenceWorker,
  
  // AI workers
  analyzeCapturedThought,
  processAnalyzedThought,
  entityEmbeddingWorker,
  
  // Shared workers
  handleNewEvent,
  handleWebhookDelivery,
  globalValidator,
];
