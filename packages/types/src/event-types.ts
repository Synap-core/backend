/**
 * Event Types - Centralized Event Type Registry
 * 
 * V0.6: Centralized event types to eliminate magic strings and improve type safety.
 * 
 * All event types used in the system should be defined here.
 * This provides:
 * - Type safety (no typos)
 * - IDE autocomplete
 * - Easy refactoring
 * - Single source of truth
 * 
 * @example
 * ```typescript
 * import { EventTypes } from '@synap/types';
 * 
 * const event = createSynapEvent({
 *   type: EventTypes.NOTE_CREATION_REQUESTED,
 *   // ...
 * });
 * ```
 */

/**
 * Event Types Constant Object
 * 
 * All event types in the Synap system.
 * Organized by domain/feature area.
 */
export const EventTypes = {
  // ============================================================================
  // Entity Lifecycle Events
  // ============================================================================
  ENTITY_CREATED: 'entity.created',
  ENTITY_UPDATED: 'entity.updated',
  ENTITY_DELETED: 'entity.deleted',

  // ============================================================================
  // Note Events
  // ============================================================================
  NOTE_CREATION_REQUESTED: 'note.creation.requested',
  NOTE_CREATION_COMPLETED: 'note.creation.completed',

  // ============================================================================
  // Task Events
  // ============================================================================
  TASK_CREATION_REQUESTED: 'task.creation.requested',
  TASK_CREATION_COMPLETED: 'task.creation.completed',
  TASK_COMPLETION_REQUESTED: 'task.completion.requested',
  TASK_COMPLETION_COMPLETED: 'task.completion.completed',
  TASK_COMPLETED: 'task.completed', // Legacy event type

  // ============================================================================
  // Project Events
  // ============================================================================
  PROJECT_CREATION_REQUESTED: 'project.creation.requested',
  PROJECT_CREATION_COMPLETED: 'project.creation.completed',

  // ============================================================================
  // Conversation Events
  // ============================================================================
  CONVERSATION_MESSAGE_SENT: 'conversation.message.sent',
  CONVERSATION_RESPONSE_GENERATED: 'conversation.response.generated',

  // ============================================================================
  // AI Events
  // ============================================================================
  AI_THOUGHT_ANALYZED: 'ai.thought.analyzed',
  AI_EMBEDDING_GENERATED: 'ai.embedding.generated',

  // ============================================================================
  // System Events (Inngest Event Bus)
  // ============================================================================
  API_EVENT_LOGGED: 'api/event.logged',
  API_THOUGHT_CAPTURED: 'api/thought.captured',

  // ============================================================================
  // Hub Protocol Events (V1.0)
  // ============================================================================
  HUB_ACCESS_LOGGED: 'hub.access.logged',
  HUB_TOKEN_GENERATED: 'hub.token.generated',
  HUB_DATA_REQUESTED: 'hub.data.requested',
  HUB_INSIGHT_SUBMITTED: 'hub.insight.submitted',

  // ============================================================================
  // DEPRECATED: AI Enrichment Events
  // ============================================================================
  // These event types are deprecated in favor of the unified metadata approach.
  // Instead of emitting separate enrichment events, use the metadata field on
  // regular events (entity.created, etc.) with AI context.
  // See: @synap/types/event-metadata for the new approach.
  //
  // Kept for backward compatibility - will be removed in v2.0
  /** @deprecated Use metadata.ai instead */
  ENRICHMENT_ENTITY_EXTRACTED: 'enrichment.entity.extracted',
  /** @deprecated Use metadata.ai instead */
  ENRICHMENT_PROPERTIES_INFERRED: 'enrichment.entity.properties.inferred',
  /** @deprecated Use metadata.ai instead */
  ENRICHMENT_RELATIONSHIPS_DISCOVERED: 'enrichment.entity.relationships.discovered',
  /** @deprecated Use metadata.ai instead */
  ENRICHMENT_ENTITY_CLASSIFIED: 'enrichment.entity.classified',
  /** @deprecated Use metadata.ai instead */
  ENRICHMENT_KNOWLEDGE_EXTRACTED: 'enrichment.knowledge.extracted',
  /** @deprecated Use metadata.ai instead */
  ENRICHMENT_REASONING_RECORDED: 'enrichment.reasoning.recorded',
} as const;

/**
 * Event Type Type
 * 
 * Type-safe event type extracted from EventTypes constant.
 */
export type EventType = typeof EventTypes[keyof typeof EventTypes];

/**
 * Validate event type
 * 
 * Checks if a string is a valid event type.
 * 
 * @param eventType - String to validate
 * @returns true if eventType is a valid event type
 */
export function isValidEventType(eventType: string): eventType is EventType {
  return Object.values(EventTypes).includes(eventType as EventType);
}

/**
 * Get all event types
 * 
 * @returns Array of all valid event types
 */
export function getAllEventTypes(): readonly EventType[] {
  return Object.values(EventTypes);
}

