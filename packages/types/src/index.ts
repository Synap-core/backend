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

export {
  EventTypes,
  type EventType,
  isValidEventType,
  getAllEventTypes,
} from './event-types.js';

