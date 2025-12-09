/**
 * Enrichment Event Schemas
 * 
 * Event data schemas for AI enrichment events.
 * These define the structure of data payloads for enrichment events.
 * 
 * @module @synap/types/enrichment-events
 */

import { z } from 'zod';

// ============================================================================
// ENTITY EXTRACTION EVENT
// ============================================================================

/**
 * Entity Extraction Event Schema
 * 
 * Published when AI extracts an entity from a message.
 * This creates the provenance link between entities and conversations.
 */
export const EntityExtractedEventSchema = z.object({
  // What was enriched
  entityId: z.string().uuid(),
  
  // Where it came from
  sourceMessageId: z.string().uuid(),
  sourceThreadId: z.string().uuid(),
  
  // AI metadata
  extractedBy: z.string().min(1), // Agent ID: 'orchestrator', 'research-agent', etc.
  confidence: z.number().min(0).max(1),
  
  // Extraction details
  extractionMethod: z.enum([
    'explicit',       // User explicitly asked to create
    'implicit',       // AI inferred from context
    'relationship',   // Discovered via relationship to another entity
  ]),
  
  // Optional reasoning trace for transparency
  reasoningTrace: z.string().optional(),
});

export type EntityExtractedEvent = z.infer<typeof EntityExtractedEventSchema>;

// ============================================================================
// PROPERTIES INFERRED EVENT
// ============================================================================

/**
 * Entity Properties Inferred Event Schema
 * 
 * Published when AI infers structured properties for an entity.
 * Properties are flexible and domain-specific.
 */
export const PropertiesInferredEventSchema = z.object({
  entityId: z.string().uuid(),
  
  // The inferred properties (flexible schema)
  properties: z.record(z.unknown()),
  
  // AI metadata
  inferredBy: z.string().min(1),
  confidence: z.number().min(0).max(1),
  
  // What triggered this inference
  trigger: z.enum([
    'creation',        // On entity creation
    'update',          // On entity update
    'context_change',  // Context around entity changed
    'user_request',    // User explicitly asked for analysis
  ]),
  
  // Optional: previous properties for diff
  previousProperties: z.record(z.unknown()).optional(),
});

export type PropertiesInferredEvent = z.infer<typeof PropertiesInferredEventSchema>;

// ============================================================================
// RELATIONSHIPS DISCOVERED EVENT
// ============================================================================

/**
 * Entity Relationships Discovered Event Schema
 * 
 * Published when AI discovers relationships between entities.
 * Enables knowledge graph construction.
 */
export const RelationshipsDiscoveredEventSchema = z.object({
  sourceEntityId: z.string().uuid(),
  targetEntityId: z.string().uuid(),
  
  // Relationship type
  relationshipType: z.enum([
    'related_to',     // Generic relationship
    'part_of',        // Hierarchical: A is part of B
    'depends_on',     // Dependency: A depends on B
    'mentioned_in',   // Reference: A mentions B
    'created_from',   // Derivation: A was created from B
    'supersedes',     // Versioning: A replaces B
    'similar_to',     // Similarity: A is semantically similar to B
    'contradicts',    // Conflict: A contradicts B
  ]),
  
  // AI metadata
  discoveredBy: z.string().min(1),
  confidence: z.number().min(0).max(1),
  
  // Is this relationship bidirectional?
  bidirectional: z.boolean().default(false),
  
  // Optional context for why this relationship was discovered
  context: z.string().optional(),
});

export type RelationshipsDiscoveredEvent = z.infer<typeof RelationshipsDiscoveredEventSchema>;

// ============================================================================
// ENTITY CLASSIFIED EVENT
// ============================================================================

/**
 * Entity Classified Event Schema
 * 
 * Published when AI classifies/categorizes an entity.
 */
export const EntityClassifiedEventSchema = z.object({
  entityId: z.string().uuid(),
  
  // Classification results
  classifications: z.array(z.object({
    category: z.string(),
    confidence: z.number().min(0).max(1),
    tags: z.array(z.string()).optional(),
  })),
  
  // AI metadata
  classifiedBy: z.string().min(1),
  
  // Classification method
  method: z.enum([
    'embedding_similarity',  // Based on vector similarity
    'llm_analysis',         // Based on LLM reasoning
    'rule_based',           // Based on rules/patterns
  ]),
});

export type EntityClassifiedEvent = z.infer<typeof EntityClassifiedEventSchema>;

// ============================================================================
// KNOWLEDGE EXTRACTED EVENT
// ============================================================================

/**
 * Knowledge Extracted Event Schema
 * 
 * Published when AI extracts factual knowledge from content.
 */
export const KnowledgeExtractedEventSchema = z.object({
  // The extracted fact
  fact: z.string(),
  factType: z.enum([
    'assertion',      // Statement of truth
    'definition',     // What something is
    'relationship',   // How things relate
    'procedure',      // How to do something
    'preference',     // User preference
  ]),
  
  // Source
  sourceEntityId: z.string().uuid().optional(),
  sourceMessageId: z.string().uuid().optional(),
  
  // AI metadata
  extractedBy: z.string().min(1),
  confidence: z.number().min(0).max(1),
  
  // Embedding for retrieval (optional - can be generated separately)
  embedding: z.array(z.number()).optional(),
});

export type KnowledgeExtractedEvent = z.infer<typeof KnowledgeExtractedEventSchema>;

// ============================================================================
// REASONING RECORDED EVENT
// ============================================================================

/**
 * Reasoning Recorded Event Schema
 * 
 * Published to record AI reasoning for transparency and debugging.
 * Enables users to understand AI decisions.
 */
export const ReasoningRecordedEventSchema = z.object({
  // What this reasoning is about
  subjectType: z.enum(['entity', 'message', 'thread', 'query', 'task']),
  subjectId: z.string().uuid(),
  
  // The agent that did the reasoning
  agentId: z.string().min(1),
  
  // Reasoning steps
  steps: z.array(z.object({
    type: z.enum([
      'thinking',       // Internal reasoning
      'tool_call',      // Called a tool
      'tool_result',    // Tool returned result
      'decision',       // Made a decision
      'observation',    // Observed something
    ]),
    content: z.string(),
    timestamp: z.coerce.date(),
    metadata: z.record(z.unknown()).optional(),
  })),
  
  // Outcome
  outcome: z.object({
    action: z.string(),
    confidence: z.number().min(0).max(1),
    alternatives: z.array(z.string()).optional(),
  }),
  
  // Performance metrics
  metrics: z.object({
    totalDurationMs: z.number(),
    tokenCount: z.number().optional(),
    toolCallCount: z.number().optional(),
  }).optional(),
});

export type ReasoningRecordedEvent = z.infer<typeof ReasoningRecordedEventSchema>;

// ============================================================================
// UNION TYPE
// ============================================================================

/**
 * All enrichment event data types
 */
export type EnrichmentEventData = 
  | EntityExtractedEvent
  | PropertiesInferredEvent
  | RelationshipsDiscoveredEvent
  | EntityClassifiedEvent
  | KnowledgeExtractedEvent
  | ReasoningRecordedEvent;

/**
 * Enrichment event type to schema mapping
 */
export const EnrichmentEventSchemas = {
  'enrichment.entity.extracted': EntityExtractedEventSchema,
  'enrichment.entity.properties.inferred': PropertiesInferredEventSchema,
  'enrichment.entity.relationships.discovered': RelationshipsDiscoveredEventSchema,
  'enrichment.entity.classified': EntityClassifiedEventSchema,
  'enrichment.knowledge.extracted': KnowledgeExtractedEventSchema,
  'enrichment.reasoning.recorded': ReasoningRecordedEventSchema,
} as const;

export type EnrichmentEventType = keyof typeof EnrichmentEventSchemas;

/**
 * Validate enrichment event data
 */
export function validateEnrichmentEventData<T extends EnrichmentEventType>(
  eventType: T,
  data: unknown
): z.infer<typeof EnrichmentEventSchemas[T]> {
  const schema = EnrichmentEventSchemas[eventType];
  return schema.parse(data);
}
