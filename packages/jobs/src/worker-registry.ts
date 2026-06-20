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
  // Messaging Workers (external conversation routing)
  // ============================================================================
  {
    id: "crm-daily-digest",
    name: "CRM Daily Digest",
    description:
      "Posts a morning summary of unread linked conversations and overdue follow-ups to each user's personal channel. Runs daily at 08:55 UTC.",
    triggers: ["cron:55 8 * * *"],
    outputs: ["message.create.completed"],
    category: "ai",
  },
  {
    id: "proactive-intelligence",
    name: "Proactive Intelligence (scan)",
    description:
      "proactive.scan assembles a candidate cluster (recent entities of one profile in a workspace) and hands it to the intelligence service, which runs the agent and emits a proposal or a proactive_post nudge. Reachable as an action a loop/automation invokes — no parallel per-event auto-trigger.",
    triggers: ["queue:proactive.scan"],
    category: "ai",
  },

  // ============================================================================
  // Table Workers (handle CRUD for database tables)
  // ============================================================================
  {
    id: "entities-worker",
    name: "Entities Worker",
    description:
      "Handles all entity CRUD operations (notes, tasks, projects, etc.)",
    triggers: [
      "entity.create.requested",
      "entity.update.requested",
      "entity.delete.requested",
    ],
    outputs: [
      "entity.create.validated",
      "entity.update.validated",
      "entity.delete.validated",
    ],
    category: "table",
  },
  {
    id: "documents-worker",
    name: "Documents Worker",
    description: "Handles document creation, versioning, and collaboration",
    triggers: [
      "document.create.requested",
      "document.update.requested",
      "document.delete.requested",
    ],
    outputs: [
      "document.create.validated",
      "document.update.validated",
      "document.delete.validated",
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
    triggers: ["entity.create.validated"],
    category: "ai",
  },
  {
    id: "insight-detector",
    name: "Insight Pattern Detector",
    description: "Detects patterns and generates insights from entities",
    triggers: ["entity.create.validated", "entity.update.validated"],
    category: "ai",
  },
  {
    id: "entity-embedding",
    name: "Entity Embedding Indexer",
    description: "Generates and indexes embeddings for semantic search",
    triggers: ["entity.create.validated", "entity.update.validated"],
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
  category: WorkerMetadata["category"]
): WorkerMetadata[] {
  return workerRegistry.filter((w) => w.category === category);
}

/**
 * Get workers that listen to a specific event type
 */
export function getWorkersForEvent(eventType: string): WorkerMetadata[] {
  return workerRegistry.filter(
    (w) => w.triggers.includes(eventType) || w.triggers.includes("*")
  );
}

/**
 * Get worker by ID
 */
export function getWorkerById(id: string): WorkerMetadata | undefined {
  return workerRegistry.find((w) => w.id === id);
}
