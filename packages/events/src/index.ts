/**
 * @synap/events - Schema-Driven Event System
 * 
 * This package provides:
 * - Type-safe domain event definitions
 * - Type-safe event publisher
 * - Auto-generated event types from database tables
 * - Type-safe payload schemas (Zod)
 * - Runtime event registry
 * 
 * Pattern: {table}.{action}.{modifier}
 * Example: entities.create.requested
 * 
 * @example
 * ```typescript
 * import { publishEvent, createInboxItemReceivedEvent } from '@synap/events';
 * 
 * // Type-safe event publishing
 * const event = createInboxItemReceivedEvent(itemId, {
 *   provider: 'gmail',
 *   externalId: '123',
 *   type: 'email',
 *   title: 'Meeting invite',
 *   timestamp: new Date(),
 *   rawData: {}
 * });
 * 
 * await publishEvent(event, { userId: 'user_123' });
 * ```
 */

// ============================================================================
// DOMAIN EVENTS (Type-Safe Event System)
// ============================================================================

export type {
  // Base types
  BaseEvent,
  DomainEvent,
  EventType,
  SubjectType,
  EventDataFor,
  SubjectTypeFor,
  EventsForSubject,
  
  // Inbox events
  InboxItemReceivedEvent,
  InboxItemAnalyzedEvent,
  InboxItemStatusUpdatedEvent,
  
  // Entity events
  EntityCreateRequestedEvent,
  EntityCreateCompletedEvent,
  EntityUpdateRequestedEvent,
  
  // Document events
  DocumentCreateRequestedEvent,
  DocumentCreateCompletedEvent,
  
  // Message events
  MessageCreateRequestedEvent,
  
  // Chat thread events
  ChatThreadCreateRequestedEvent,
} from './domain-events.js';

// ============================================================================
// TYPE-SAFE PUBLISHER
// ============================================================================

export {
  publishEvent,
  createInboxItemReceivedEvent,
  createInboxItemAnalyzedEvent,
  createInboxItemStatusUpdatedEvent,
  createEntityCreateRequestedEvent,
  createEntityCreateCompletedEvent,
  type PublishEventOptions,
} from './publisher.js';

// ============================================================================
// GENERATOR (Auto-generated event types from tables)
// ============================================================================

export {
  generateTableEventTypes,
  GeneratedEventTypes,
  getAllGeneratedEventTypes,
  isGeneratedEventType,
  parseEventType,
  CORE_TABLES,
  type CoreTable,
  type TableAction,
  type TableEventTypes,
  type GeneratedEventType,
} from './generator.js';

// ============================================================================
// PAYLOADS (Zod schemas for validation)
// ============================================================================

export {
  // Base schemas
  MetadataSchema,
  RequestContextSchema,
  
  // Entity schemas
  EntityTypeSchema,
  FileAttachmentSchema,
  EntitiesCreateRequestedPayload,
  EntitiesCreateCompletedPayload,
  EntitiesUpdateRequestedPayload,
  
  // Document schemas
  DocumentsCreateRequestedPayload,
  DocumentsCreateCompletedPayload,
  
  // Message schemas
  MessageAttachmentSchema,
  ConversationMessagesCreateRequestedPayload,
  
  // Chat thread schemas
  ChatThreadsCreateRequestedPayload,
  
  // Task details schemas
  TaskDetailsCreateRequestedPayload,
  
  // Schema registry
  GeneratedPayloadSchemas,
  getPayloadSchema,
  validatePayload,
  
  type EntityType,
  type GeneratedPayloadSchemaType,
} from './payloads.js';

// ============================================================================
// REGISTRY (Runtime event tracking)
// ============================================================================

export {
  eventRegistry,
  registerGeneratedEvents,
  getTableEventSummary,
  type EventRegistration,
  type EventRegistryStats,
} from './registry.js';
