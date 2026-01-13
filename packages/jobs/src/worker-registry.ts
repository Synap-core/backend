/**
 * Worker Registry - Static worker metadata for Admin UI
 *
 * V2.0: Simplified registry with only active workers
 *
 * Pattern: Table workers handle {table}.{crud}.requested events
 * and emit {table}.{crud}.completed events.
 */

export interface WorkerMetadata {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  outputs?: string[];
  category: "table" | "shared" | "ai";
}

/**
 * Active worker registry
 *
 * Maintained manually to match ./functions/*.ts
 */
export const workerRegistry: WorkerMetadata[] = [
  // ============================================================================
  // Table Workers (handle CRUD for database tables)
  // ============================================================================
  {
    id: "entities-worker",
    name: "Entities Worker",
    description:
      "Handles all entity CRUD operations (notes, tasks, projects, etc.)",
    triggers: [
      "entities.create.requested",
      "entities.update.requested",
      "entities.delete.requested",
    ],
    outputs: [
      "entities.create.validated",
      "entities.update.validated",
      "entities.delete.validated",
    ],
    category: "table",
  },
  {
    id: "documents-worker",
    name: "Documents Worker",
    description: "Handles document creation, versioning, and collaboration",
    triggers: [
      "documents.create.requested",
      "documents.update.requested",
      "documents.delete.requested",
    ],
    outputs: [
      "documents.create.validated",
      "documents.update.validated",
      "documents.delete.validated",
    ],
    category: "table",
  },
  {
    id: "messages-worker",
    name: "Messages Worker",
    description: "Handles conversation messages and chat threads",
    triggers: [
      "conversationMessages.create.requested",
      "conversationMessages.update.requested",
    ],
    outputs: [
      "conversationMessages.create.validated",
      "conversationMessages.update.validated",
    ],
    category: "table",
  },

  // ============================================================================
  // AI Workers (intelligent processing)
  // ============================================================================
  {
    id: "thought-analyzer",
    name: "Thought Analyzer",
    description: "AI-powered thought analysis and classification",
    triggers: ["entities.create.validated"],
    category: "ai",
  },
  {
    id: "insight-detector",
    name: "Insight Pattern Detector",
    description: "Detects patterns and generates insights from entities",
    triggers: ["entities.create.validated", "entities.update.validated"],
    category: "ai",
  },
  {
    id: "entity-embedding",
    name: "Entity Embedding Indexer",
    description: "Generates and indexes embeddings for semantic search",
    triggers: ["entities.create.validated", "entities.update.validated"],
    category: "ai",
  },

  // ============================================================================
  // Shared Workers (cross-cutting concerns)
  // ============================================================================
  {
    id: "webhook-broker",
    name: "Webhook Broker",
    description: "Delivers events to external webhook subscribers",
    triggers: ["*"], // Subscribes to all events
    category: "shared",
  },
];

/**
 * Get all workers
 */
export function getAllWorkers(): WorkerMetadata[] {
  return workerRegistry;
}

/**
 * Get workers by category
 */
export function getWorkersByCategory(
  category: WorkerMetadata["category"],
): WorkerMetadata[] {
  return workerRegistry.filter((w) => w.category === category);
}

/**
 * Get workers that listen to a specific event type
 */
export function getWorkersForEvent(eventType: string): WorkerMetadata[] {
  return workerRegistry.filter(
    (w) => w.triggers.includes(eventType) || w.triggers.includes("*"),
  );
}

/**
 * Get worker by ID
 */
export function getWorkerById(id: string): WorkerMetadata | undefined {
  return workerRegistry.find((w) => w.id === id);
}
