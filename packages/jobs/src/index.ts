/**
 * Jobs Package - Main Export
 *
 * V2.0: Simplified Schema-Driven Event Architecture
 *
 * This package exports:
 * - Table workers (messages, workspace-members)
 * - AI workers (analyzer, embeddings, insights)
 * - Shared workers (webhooks, permissions)
 * - Executors (Unified Execution Layer)
 * - Worker registry for admin UI
 */

export * from "./client.js";
export * from "./worker-registry.js";
export * from "./utils/realtime-broadcast.js";

// Unified event types
export * from "./types/index.js";

// ============================================================================
// Table Workers (Legacy - Being Replaced by Executors)
// ============================================================================
export {
  whiteboardSnapshotWorker,
  whiteboardRestoreWorker,
  whiteboardAutoSaveWorker,
} from "./functions/whiteboard-snapshots.js";
export {
  documentSnapshotWorker,
  documentRestoreWorker,
  documentAutoSaveWorker,
} from "./functions/document-snapshots.js";
export { documentPersistenceWorker } from "./functions/document-persistence.js";

// ============================================================================
// AI Workers
// ============================================================================
export { analyzeCapturedThought } from "./functions/ai-analyzer.js";
export { processAnalyzedThought } from "./functions/thought-processor.js";
export { entityEmbeddingWorker } from "./functions/entity-embedding.js";

// ============================================================================
// Shared Workers
// ============================================================================

export { handleWebhookDelivery } from "./functions/webhook-broker.js";
export { globalValidator, globalValidator2 } from "./functions/global-validator.js";

// ============================================================================
// Executors (Unified Execution Layer)
// ============================================================================
export * from "./executors/index.js";

// ============================================================================
// Search Functions (Typesense Integration)
// ============================================================================
export { searchIndexer } from "./search/search-indexer.js";
export { bulkIndexer } from "./search/bulk-indexer.js";
export { reindexWorker } from "./search/reindex-worker.js";

// ============================================================================
// INNGEST FUNCTION REGISTRY
// ============================================================================

import {
  whiteboardSnapshotWorker,
  whiteboardRestoreWorker,
  whiteboardAutoSaveWorker,
} from "./functions/whiteboard-snapshots.js";
import {
  documentSnapshotWorker,
  documentRestoreWorker,
  documentAutoSaveWorker,
} from "./functions/document-snapshots.js";
import { documentPersistenceWorker } from "./functions/document-persistence.js";

import { analyzeCapturedThought } from "./functions/ai-analyzer.js";
import { processAnalyzedThought } from "./functions/thought-processor.js";
import { entityEmbeddingWorker } from "./functions/entity-embedding.js";
import { searchIndexer } from "./search/search-indexer.js";
import { bulkIndexer } from "./search/bulk-indexer.js";
import { handleWebhookDelivery } from "./functions/webhook-broker.js";
import { globalValidator, globalValidator2 } from "./functions/global-validator.js";
import {
  viewsExecutor,
  entitiesExecutor,
  documentsExecutor,
  workspacesExecutor,
  inboxExecutor,
  sharingExecutor,
  templatesExecutor,
  relationsExecutor,
  messagesExecutor,
  workspaceMembersExecutor,
  projectMembersExecutor,
  rolesExecutor,
  apiKeysExecutor,
  threadContextExecutor,
  skillsExecutor,
  backgroundTasksExecutor,
  createDefaultWhiteboard,
  createDefaultViews,
  createDefaultCommands,
} from "./executors/index.js";

/**
 * All Inngest functions to register with the serve handler.
 */
export const functions = [
  // Table workers (legacy - being replaced by executors)
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

  // Search workers
  searchIndexer,
  bulkIndexer,

  // Shared workers
  handleWebhookDelivery,
  globalValidator,
  globalValidator2,

  // Executors (Unified Execution Layer)
  viewsExecutor,
  entitiesExecutor,
  documentsExecutor,
  workspacesExecutor,
  inboxExecutor,
  sharingExecutor,
  templatesExecutor,
  relationsExecutor,
  messagesExecutor,
  workspaceMembersExecutor,
  rolesExecutor,
  apiKeysExecutor,
  projectMembersExecutor,
  threadContextExecutor,
  skillsExecutor,
  backgroundTasksExecutor,
  createDefaultWhiteboard,
  createDefaultViews,
  createDefaultCommands,
];
