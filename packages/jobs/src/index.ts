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
export { globalValidator } from "./functions/global-validator.js";

// ============================================================================
// Executors (Unified Execution Layer)
// ============================================================================
export * from "./executors/index.js";

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
import { handleWebhookDelivery } from "./functions/webhook-broker.js";
import { globalValidator } from "./functions/global-validator.js";
import {
  tagsExecutor,
  viewsExecutor,
  entitiesExecutor,
  documentsExecutor,
  workspacesExecutor,
  projectsExecutor,
  inboxExecutor,
  sharingExecutor,
  templatesExecutor,
  relationsExecutor,
  messagesExecutor,
  workspaceMembersExecutor,
  projectMembersExecutor,
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

  // Shared workers
  handleWebhookDelivery,
  globalValidator,

  // Executors (Unified Execution Layer)
  tagsExecutor,
  viewsExecutor,
  entitiesExecutor,
  documentsExecutor,
  workspacesExecutor,
  projectsExecutor,
  inboxExecutor,
  sharingExecutor,
  templatesExecutor,
  relationsExecutor,
  messagesExecutor,
  workspaceMembersExecutor,
  projectMembersExecutor,
];
