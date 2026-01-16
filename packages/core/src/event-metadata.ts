/**
 * Event Metadata Types
 *
 * Defines the structure of metadata that can be attached to ANY event.
 * Metadata provides context about HOW/WHY an event happened, while
 * event data describes WHAT happened.
 *
 * Key Design Principle:
 * - Events are first-class citizens regardless of creator (user or AI)
 * - The event type stays the same (e.g., 'entity.created')
 * - Metadata tells the story of how the event came to be
 *
 * @module @synap/types/event-metadata
 */

import { z } from "zod";

// ============================================================================
// AI METADATA
// ============================================================================

/**
 * AI Extraction Context
 *
 * When AI extracts an entity from a conversation, this metadata
 * provides the provenance and confidence information.
 */
export const AIExtractionMetadataSchema = z.object({
  // Where this was extracted from
  extractedFrom: z.object({
    messageId: z.string().uuid(),
    threadId: z.string().uuid(),
    content: z.string().optional(), // Snippet that triggered extraction
  }),

  // Extraction details
  method: z.enum([
    "explicit", // User explicitly asked ("create a task...")
    "implicit", // AI inferred from context
    "relationship", // Discovered via relationship to another entity
  ]),
});

export type AIExtractionMetadata = z.infer<typeof AIExtractionMetadataSchema>;

/**
 * AI Confidence Metadata
 *
 * Confidence scoring for AI-generated content.
 */
export const AIConfidenceMetadataSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});

export type AIConfidenceMetadata = z.infer<typeof AIConfidenceMetadataSchema>;

/**
 * AI Classification Metadata
 *
 * When AI classifies or categorizes content.
 */
export const AIClassificationMetadataSchema = z.object({
  categories: z.array(
    z.object({
      name: z.string(),
      confidence: z.number().min(0).max(1),
    })
  ),
  tags: z.array(z.string()).optional(),
  method: z.enum(["embedding_similarity", "llm_analysis", "rule_based"]),
});

export type AIClassificationMetadata = z.infer<
  typeof AIClassificationMetadataSchema
>;

/**
 * AI Reasoning Trace Metadata
 *
 * Records the AI's reasoning process for transparency.
 */
export const AIReasoningMetadataSchema = z.object({
  steps: z.array(
    z.object({
      type: z.enum([
        "thinking",
        "tool_call",
        "tool_result",
        "decision",
        "observation",
      ]),
      content: z.string(),
      timestamp: z.coerce.date().optional(),
    })
  ),

  outcome: z
    .object({
      action: z.string(),
      confidence: z.number().min(0).max(1),
      alternatives: z.array(z.string()).optional(),
    })
    .optional(),

  // Performance metrics
  durationMs: z.number().optional(),
  tokenCount: z.number().optional(),
});

export type AIReasoningMetadata = z.infer<typeof AIReasoningMetadataSchema>;

/**
 * AI Relationship Discovery Metadata
 *
 * When AI discovers relationships between entities.
 */
export const AIRelationshipMetadataSchema = z.object({
  relationships: z.array(
    z.object({
      targetEntityId: z.string().uuid(),
      type: z.enum([
        "related_to",
        "part_of",
        "depends_on",
        "mentioned_in",
        "created_from",
        "supersedes",
        "similar_to",
        "contradicts",
      ]),
      confidence: z.number().min(0).max(1),
      bidirectional: z.boolean().default(false),
    })
  ),
});

export type AIRelationshipMetadata = z.infer<
  typeof AIRelationshipMetadataSchema
>;

/**
 * Complete AI Metadata Schema
 *
 * The full AI metadata structure that can be attached to any event.
 * All fields are optional - use only what's relevant.
 */
export const AIMetadataSchema = z.object({
  // Which agent produced this
  agent: z.string().min(1),

  // Confidence in the overall action
  confidence: AIConfidenceMetadataSchema.optional(),

  // If extracted from conversation
  extraction: AIExtractionMetadataSchema.optional(),

  // If classification was performed
  classification: AIClassificationMetadataSchema.optional(),

  // If relationships were discovered
  relationships: AIRelationshipMetadataSchema.optional(),

  // Reasoning trace for transparency
  reasoning: AIReasoningMetadataSchema.optional(),

  // Inferred properties (flexible)
  inferredProperties: z.record(z.unknown()).optional(),
});

export type AIMetadata = z.infer<typeof AIMetadataSchema>;

// ============================================================================
// IMPORT METADATA
// ============================================================================

/**
 * Import Metadata
 *
 * When entities/content are imported from external sources.
 */
export const ImportMetadataSchema = z.object({
  source: z.enum([
    "notion",
    "obsidian",
    "roam",
    "logseq",
    "markdown",
    "csv",
    "api",
    "other",
  ]),

  // Original identifiers
  externalId: z.string().optional(),
  externalUrl: z.string().url().optional(),

  // Import details
  importedAt: z.coerce.date(),
  batchId: z.string().uuid().optional(),

  // Transformation info
  transformed: z.boolean().default(false),
  transformationNotes: z.string().optional(),
});

export type ImportMetadata = z.infer<typeof ImportMetadataSchema>;

// ============================================================================
// SYNC METADATA
// ============================================================================

/**
 * Sync Metadata
 *
 * When events are synced from mobile or other devices.
 */
export const SyncMetadataSchema = z.object({
  deviceId: z.string(),
  platform: z.enum(["ios", "android", "web", "desktop", "cli"]),

  // Sync state
  syncedAt: z.coerce.date(),
  offline: z.boolean().default(false),
  conflictResolution: z
    .enum(["client_wins", "server_wins", "merged"])
    .optional(),
});

export type SyncMetadata = z.infer<typeof SyncMetadataSchema>;

// ============================================================================
// AUTOMATION METADATA
// ============================================================================

/**
 * Automation Metadata
 *
 * When events are triggered by rules/automations.
 */
export const AutomationMetadataSchema = z.object({
  ruleId: z.string().uuid(),
  ruleName: z.string(),

  // What triggered it
  trigger: z.object({
    type: z.string(),
    event: z.string().optional(),
    schedule: z.string().optional(), // cron expression
  }),

  // Execution context
  executionId: z.string().uuid().optional(),
});

export type AutomationMetadata = z.infer<typeof AutomationMetadataSchema>;

// ============================================================================
// UNIFIED EVENT METADATA
// ============================================================================

/**
 * Complete Event Metadata Schema
 *
 * The top-level metadata structure that can be attached to any SynapEvent.
 * All sections are optional - only include what's relevant.
 *
 * @example
 * ```typescript
 * // Entity created by AI extraction
 * const event = createSynapEvent({
 *   type: EventTypes.ENTITY_CREATED,
 *   data: { id: '...', type: 'task', title: 'Call John' },
 *   source: 'intelligence',
 *   metadata: {
 *     ai: {
 *       agent: 'orchestrator',
 *       confidence: { score: 0.92 },
 *       extraction: {
 *         extractedFrom: { messageId: '...', threadId: '...' },
 *         method: 'explicit',
 *       },
 *     },
 *   },
 * });
 *
 * // Entity created by user (no metadata needed)
 * const event = createSynapEvent({
 *   type: EventTypes.ENTITY_CREATED,
 *   data: { id: '...', type: 'task', title: 'Call John' },
 *   source: 'api',
 *   // metadata is undefined - user created directly
 * });
 * ```
 */
export const EventMetadataSchema = z.object({
  // AI enrichment context
  ai: AIMetadataSchema.optional(),

  // Import context
  import: ImportMetadataSchema.optional(),

  // Sync context
  sync: SyncMetadataSchema.optional(),

  // Automation context
  automation: AutomationMetadataSchema.optional(),

  // Extensible: any additional context
  custom: z.record(z.unknown()).optional(),
});

export type EventMetadata = z.infer<typeof EventMetadataSchema>;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Create AI metadata for entity extraction
 */
export function createAIExtractionMetadata(params: {
  agent: string;
  messageId: string;
  threadId: string;
  confidence: number;
  method?: "explicit" | "implicit" | "relationship";
  reasoning?: string;
}): EventMetadata {
  return {
    ai: {
      agent: params.agent,
      confidence: {
        score: params.confidence,
        reasoning: params.reasoning,
      },
      extraction: {
        extractedFrom: {
          messageId: params.messageId,
          threadId: params.threadId,
        },
        method: params.method ?? "explicit",
      },
    },
  };
}

/**
 * Create AI metadata for classification
 */
export function createAIClassificationMetadata(params: {
  agent: string;
  categories: Array<{ name: string; confidence: number }>;
  tags?: string[];
  method?: "embedding_similarity" | "llm_analysis" | "rule_based";
}): EventMetadata {
  return {
    ai: {
      agent: params.agent,
      classification: {
        categories: params.categories,
        tags: params.tags,
        method: params.method ?? "llm_analysis",
      },
    },
  };
}

/**
 * Create AI metadata with reasoning trace
 */
export function createAIReasoningMetadata(params: {
  agent: string;
  steps: Array<{
    type: "thinking" | "tool_call" | "tool_result" | "decision" | "observation";
    content: string;
  }>;
  outcome?: { action: string; confidence: number };
  durationMs?: number;
}): EventMetadata {
  return {
    ai: {
      agent: params.agent,
      reasoning: {
        steps: params.steps,
        outcome: params.outcome,
        durationMs: params.durationMs,
      },
    },
  };
}

/**
 * Check if event has AI metadata
 */
export function hasAIMetadata(
  metadata: unknown
): metadata is EventMetadata & { ai: AIMetadata } {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "ai" in metadata &&
    typeof (metadata as any).ai === "object"
  );
}

/**
 * Extract AI agent from metadata
 */
export function getAIAgent(metadata: unknown): string | undefined {
  if (hasAIMetadata(metadata)) {
    return metadata.ai.agent;
  }
  return undefined;
}

/**
 * Extract confidence score from metadata
 */
export function getConfidenceScore(metadata: unknown): number | undefined {
  if (hasAIMetadata(metadata) && metadata.ai.confidence) {
    return metadata.ai.confidence.score;
  }
  return undefined;
}
