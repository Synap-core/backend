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
    id: "mail-feed-cron",
    name: "Mail Feed",
    description:
      "Every 2h, runs the api-side mail-feed runner (in-process) which calls gmail_search, AI-triages each email (relevance + category + summary), filters by allow/deny + muted categories, and posts one message per relevant email into the Discord-bound Synap channel (auto-mirrored to Discord). No-ops unless the Discord tool has mailFeed.enabled.",
    triggers: ["cron:0 */2 * * *"],
    outputs: ["message.create.completed"],
    category: "ai",
  },
  {
    id: "event-sync-cron",
    name: "Event Sync",
    description:
      "Every 6h, runs the api-side event-sync runner (in-process) which mirrors upcoming Synap events, Stellar grant deadlines, and Google Calendar events into native Discord scheduled events (idempotent via a dedup map in the Discord tool metadata). No-ops unless the Discord tool has eventSync.enabled.",
    triggers: ["cron:0 */6 * * *"],
    outputs: ["discord.scheduled_event.created"],
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
    id: "pagerank-centrality",
    name: "PageRank Centrality",
    description:
      "Every 6h (and on startup), recomputes a global PageRank over each user's relations graph and UPSERTs the per-entity score into entity_centrality. Horizon reads it as its centrality signal C. In-memory, one batched edge read per user, bounded iterations.",
    triggers: ["cron:20 */6 * * *"],
    outputs: ["entity_centrality.upsert"],
    category: "shared",
  },
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
