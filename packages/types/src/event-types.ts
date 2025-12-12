/**
 * Event Types - Centralized Event Type Registry
 * 
 * V1.0: Schema-Driven Event Architecture
 * 
 * Event types are now organized into:
 * 1. Generated events (auto-generated from database tables via @synap/events)
 * 2. Custom events (manually defined for non-table operations)
 * 3. Legacy events (deprecated, kept for backward compatibility)
 * 
 * @example
 * ```typescript
 * import { EventTypes, GeneratedEventTypes } from '@synap/types';
 * 
 * // Use generated table events
 * const event = createSynapEvent({
 *   type: GeneratedEventTypes.entities['create.requested'],
 *   // Result: 'entities.create.requested'
 * });
 * 
 * // Use custom events
 * const customEvent = createSynapEvent({
 *   type: EventTypes.HUB_INSIGHT_SUBMITTED,
 * });
 * ```
 */

// ============================================================================
// GENERATED EVENTS (from @synap/events)
// ============================================================================

// Re-export generated event types from @synap/events
export { 
  GeneratedEventTypes,
  getAllGeneratedEventTypes,
  isGeneratedEventType,
  parseEventType,
  type GeneratedEventType,
  type TableAction,
  type CoreTable,
} from '@synap/events';

// ============================================================================
// CUSTOM EVENTS (non-table operations)
// ============================================================================

/**
 * Custom Event Types
 * 
 * Events that don't map directly to database tables.
 * These are for system operations, AI events, hub protocol, etc.
 */
export const CustomEventTypes = {
  // System Events (Inngest Event Bus)
  API_EVENT_LOGGED: 'api/event.logged',
  API_THOUGHT_CAPTURED: 'api/thought.captured',

  // AI Events
  AI_THOUGHT_ANALYZED: 'ai.thought.analyzed',
  AI_EMBEDDING_GENERATED: 'ai.embedding.generated',

  // Hub Protocol Events (V1.0)
  HUB_ACCESS_LOGGED: 'hub.access.logged',
  HUB_TOKEN_GENERATED: 'hub.token.generated',
  HUB_DATA_REQUESTED: 'hub.data.requested',
  HUB_INSIGHT_SUBMITTED: 'hub.insight.submitted',
} as const;

export type CustomEventType = typeof CustomEventTypes[keyof typeof CustomEventTypes];

// ============================================================================
// LEGACY EVENTS (deprecated, kept for compatibility)
// ============================================================================

/**
 * Legacy Event Types
 * 
 * @deprecated These are replaced by generated table events.
 * Use GeneratedEventTypes instead.
 * Will be removed in v2.0
 */
export const LegacyEventTypes = {
  // Entity Lifecycle (replaced by entities.create, entities.update, etc.)
  /** @deprecated Use GeneratedEventTypes.entities.create */
  ENTITY_CREATED: 'entity.created',
  /** @deprecated Use GeneratedEventTypes.entities.update */
  ENTITY_UPDATED: 'entity.updated',
  /** @deprecated Use GeneratedEventTypes.entities.delete */
  ENTITY_DELETED: 'entity.deleted',

  // Note Events (replaced by entities.create.requested with entityType='note')
  /** @deprecated Use entities.create.requested with entityType='note' */
  NOTE_CREATION_REQUESTED: 'note.creation.requested',
  /** @deprecated Use entities.create.completed */
  NOTE_CREATION_COMPLETED: 'note.creation.completed',
  
  // Content (replaced by entities.create.requested)
  /** @deprecated Use entities.create.requested */
  CONTENT_CREATION_REQUESTED: 'content.creation.requested',

  // Task Events (replaced by entities.create.requested with entityType='task')
  /** @deprecated Use entities.create.requested with entityType='task' */
  TASK_CREATION_REQUESTED: 'task.creation.requested',
  /** @deprecated Use entities.create.completed */
  TASK_CREATION_COMPLETED: 'task.creation.completed',
  /** @deprecated Use entities.update.requested */
  TASK_COMPLETION_REQUESTED: 'task.completion.requested',
  /** @deprecated Use entities.update.completed */
  TASK_COMPLETION_COMPLETED: 'task.completion.completed',
  /** @deprecated Use entities.update.completed */
  TASK_COMPLETED: 'task.completed',

  // Project Events
  /** @deprecated Use entities.create.requested with entityType='project' */
  PROJECT_CREATION_REQUESTED: 'project.creation.requested',
  /** @deprecated Use entities.create.completed */
  PROJECT_CREATION_COMPLETED: 'project.creation.completed',

  // Conversation Events (replaced by conversationMessages.create.requested)
  /** @deprecated Use conversationMessages.create.requested */
  CONVERSATION_MESSAGE_SENT: 'conversation.message.sent',
  /** @deprecated Use conversationMessages.create.completed */
  CONVERSATION_RESPONSE_GENERATED: 'conversation.response.generated',

  // Enrichment Events (replaced by metadata.ai approach)
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

export type LegacyEventType = typeof LegacyEventTypes[keyof typeof LegacyEventTypes];

// ============================================================================
// COMBINED EVENT TYPES (backward compatible)
// ============================================================================

/**
 * EventTypes - All event types (for backward compatibility)
 * 
 * Combines: Custom + Legacy (Generated are accessed via GeneratedEventTypes)
 */
export const EventTypes = {
  ...CustomEventTypes,
  ...LegacyEventTypes,
} as const;

/**
 * Event Type Union
 * 
 * All possible event type values.
 */
export type EventType = 
  | CustomEventType 
  | LegacyEventType;

/**
 * Validate event type
 * 
 * Checks if a string is a valid event type (custom, legacy, or generated).
 */
export function isValidEventType(eventType: string): boolean {
  // Check custom and legacy
  if (Object.values(EventTypes).includes(eventType as EventType)) {
    return true;
  }
  
  // Check generated
  try {
    const { isGeneratedEventType } = require('@synap/events');
    return isGeneratedEventType(eventType);
  } catch {
    return false;
  }
}

/**
 * Get all event types (custom + legacy only, not generated)
 * 
 * For generated events, use getAllGeneratedEventTypes() from @synap/events
 */
export function getAllEventTypes(): readonly EventType[] {
  return Object.values(EventTypes);
}
