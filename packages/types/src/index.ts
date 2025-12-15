/**
 * @synap/types - Type Definitions and Event Contracts
 * 
 * This package provides:
 * - SynapEvent v1 schema and validation
 * - Event type registries
 * - Event factory functions
 */

export {
  SynapEventSchema,
  type SynapEvent,
  EventTypeSchemas,
  type EventTypeWithSchema,
  validateEventData,
  createSynapEvent,
  parseSynapEvent,
} from './synap-event.js';

/**
 * Synap Types - Shared TypeScript types
 */

export {
  EventTypes,
  SystemEventTypes,
  type EventType,
  type SystemEventType,
  isValidEventType,
  getAllEventTypes,
  // Re-export generated event types from @synap/events
  GeneratedEventTypes,
  getAllGeneratedEventTypes,
  isGeneratedEventType,
  parseEventType,
  type GeneratedEventType,
  type TableAction,
  type CoreTable,
} from './event-types.js';

// Chat types
export * from './chat.js';

// Event metadata types (AI, import, sync, automation)
export * from './event-metadata.js';

// Legacy: Keep enrichment-events for backward compatibility (will be deprecated)
// export * from './enrichment-events.js';
