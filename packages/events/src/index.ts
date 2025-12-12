/**
 * @synap/events - Schema-Driven Event System
 * 
 * This package provides:
 * - Auto-generated event types from database tables
 * - Type-safe payload schemas (Zod)
 * - Runtime event registry
 * 
 * Pattern: {table}.{action}.{modifier}
 * Example: entities.create.requested
 * 
 * @example
 * ```typescript
 * import { GeneratedEventTypes, EntitiesCreateRequestedPayload } from '@synap/events';
 * 
 * // Use generated event type
 * const eventType = GeneratedEventTypes.entities['create.requested'];
 * // Result: 'entities.create.requested'
 * 
 * // Validate payload
 * const payload = EntitiesCreateRequestedPayload.parse({
 *   entityType: 'note',
 *   content: 'Hello World',
 * });
 * ```
 */

// Generator - Event type generation from tables
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

// Payloads - Zod schemas for event payloads
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

// Registry - Runtime event tracking
export {
  eventRegistry,
  registerGeneratedEvents,
  getTableEventSummary,
  type EventRegistration,
  type EventRegistryStats,
} from './registry.js';
