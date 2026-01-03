/**
 * Event Types - Centralized Event Type Registry
 * 
 * V2.0: Simplified Schema-Driven Event Architecture
 * 
 * Event types are now organized into:
 * 1. Generated events (auto-generated from database tables via @synap/events)
 * 2. System events (for cross-cutting concerns)
 * 
 * Pattern: {table}.{action}.{modifier}
 * - entities.create.requested
 * - entities.create.validated
 * 
 * @example
 * ```typescript
 * import { GeneratedEventTypes } from '@synap-core/core';
 * 
 * // Use generated table events
 * const event = createSynapEvent({
 *   type: GeneratedEventTypes.entities['create.requested'],
 *   // Result: 'entities.create.requested'
 * });
 * ```
 */

// ============================================================================
// GENERATED EVENTS (from @synap/events)
// ============================================================================

// DISABLED: Circular dependency - events package depends on types
// Re-export these from @synap/events directly in consuming code instead
/*
export { 
  GeneratedEventTypes,
  getAllGeneratedEventTypes,
  isGeneratedEventType,
  parseEventType,
  type GeneratedEventType,
  type TableAction,
  type CoreTable,
} from '@synap-core/core';
*/

// ============================================================================
// SYSTEM EVENTS (cross-cutting operations)
// ============================================================================

/**
 * System Event Types
 * 
 * Events for system-wide operations that don't map to specific tables.
 * Following pattern: {domain}.{action}.{modifier}
 */
export const SystemEventTypes = {
  // Webhook delivery - triggered after any event
  WEBHOOK_DELIVERY: 'webhooks.deliver.requested',
} as const;

export type SystemEventType = typeof SystemEventTypes[keyof typeof SystemEventTypes];

// ============================================================================
// COMBINED EVENT TYPES
// ============================================================================

/**
 * EventTypes - System event types
 * 
 * For table events, use GeneratedEventTypes instead.
 */
export const EventTypes = {
  ...SystemEventTypes,
} as const;

/**
 * All possible event type values
 */
export type EventType = SystemEventType;

/**
 * Validate event type
 * 
 * Checks if a string is a valid event type (system or generated).
 */
export function isValidEventType(eventType: string): boolean {
  // Check system events
  if (Object.values(EventTypes).includes(eventType as EventType)) {
    return true;
  }
  
  // Check generated - import locally to avoid circular dependency
  try {
    const { isGeneratedEventType } = require('./generator.js');
    return isGeneratedEventType(eventType);
  } catch {
    return false;
  }
}

/**
 * Get all event types (system only, not generated)
 * 
 * For generated events, use getAllGeneratedEventTypes() from @synap/events
 */
export function getAllEventTypes(): readonly EventType[] {
  return Object.values(EventTypes);
}
