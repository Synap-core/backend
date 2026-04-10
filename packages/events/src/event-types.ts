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
  WEBHOOK_DELIVERY: "webhooks.deliver.requested",
} as const;

export type SystemEventType =
  (typeof SystemEventTypes)[keyof typeof SystemEventTypes];

// ============================================================================
// OPERATIONAL EVENTS (cross-domain pipeline events)
// ============================================================================

/**
 * Operational Event Types
 *
 * Events emitted by backend workers, cron jobs, and pipeline completions.
 * These are the events that automations react to, and that land in the event log.
 *
 * Pattern: {domain}.{action}.{modifier}
 */
export const OperationalEventTypes = {
  // Quick capture completed (from capture router)
  CAPTURE_COMPLETE: "capture.complete.completed",
  // Connector sync completed (from bulk import workers)
  CONNECTOR_SYNC_COMPLETE: "connector_sync.complete.completed",
  // Proactive message posted to feed channel
  PROACTIVE_POST: "proactive.post.completed",
  // Notification persisted to DB
  NOTIFICATION_CREATED: "notification.created",
  // Channel message created via automation output step
  CHANNEL_MESSAGE_CREATED: "channel_message.created.completed",
} as const;

export type OperationalEventType =
  (typeof OperationalEventTypes)[keyof typeof OperationalEventTypes];

// ============================================================================
// COMBINED EVENT TYPES
// ============================================================================

/**
 * EventTypes — all operational + system event type constants.
 *
 * For table-level CRUD events (entities.create.validated etc.), use
 * GeneratedEventTypes from @synap/events instead.
 */
export const EventTypes = {
  ...SystemEventTypes,
  ...OperationalEventTypes,
} as const;

/**
 * All possible event type values
 */
export type EventType = SystemEventType | OperationalEventType;

/**
 * Validate event type
 *
 * Checks if a string is a valid event type (system or generated).
 */
// Imported statically to fix ESM 'require is not defined' error
import { isGeneratedEventType } from "./generator.js";

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

  // Check generated
  return isGeneratedEventType(eventType);
}

/**
 * Get all event types (system only, not generated)
 *
 * For generated events, use getAllGeneratedEventTypes() from @synap/events
 */
export function getAllEventTypes(): readonly EventType[] {
  return Object.values(EventTypes);
}
