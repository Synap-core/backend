/**
 * @synap/events — Event Type System
 *
 * Two sets of event type constants live here:
 *
 * 1. OperationalEventTypes — the strings that emitSideEffects() produces and
 *    that automation triggers match against. THIS is the single source of truth
 *    for event-driven automation in Synap.
 *
 *    Examples: "entity.create.completed", "capture.complete.completed"
 *
 * 2. GeneratedEventTypes — a schema-documentation utility that enumerates the
 *    3-phase (requested → approved → validated) event pattern per DB table.
 *    Used by admin/introspection endpoints (system.ts, hub-transform.ts) for
 *    capability listing. NOT used for automation triggers.
 *
 *    Examples: "entities.create.validated", "entities.update.requested"
 *
 * The two systems use different naming conventions (singular vs plural table
 * name, ".completed" vs ".validated" suffix) and are intentionally separate:
 *   - OperationalEventTypes → what workers emit → what automations consume
 *   - GeneratedEventTypes   → schema-level documentation → introspection only
 */

// ============================================================================
// OPERATIONAL & SYSTEM EVENT TYPES (automation triggers — single source of truth)
// ============================================================================

export {
  EventTypes,
  SystemEventTypes,
  OperationalEventTypes,
  isValidEventType,
  getAllEventTypes,
  getEventCatalog,
  getEventType,
  type EventDefinition,
  type EventType,
  type SystemEventType,
  type OperationalEventType,
} from "./event-types.js";

// ============================================================================
// GENERATED EVENT TYPES (schema documentation + admin introspection only)
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
} from "./generator.js";

// ============================================================================
// JOB QUEUE & SIDE EFFECTS (moved from @synap/jobs to break circular dependency)
// ============================================================================

export { getBoss, startBoss, stopBoss, boss } from "./boss.js";

export { emitSideEffects, type SideEffectPayload } from "./side-effects.js";

// ============================================================================
// REALTIME EVENT SCHEMAS (Socket.IO bridge payload validation)
// ============================================================================
//
// Schemas keyed by realtime event name, used by `emitTyped` and the bridge
// to validate payloads against the {@link DomainServerToClientEvents} contract.
// See `@synap-core/types/events` for the event-name registry.

export {
  EventSchemas,
  getSchemaForEvent,
  passthroughSchema,
} from "./realtime-schemas.js";

// ============================================================================
// REALTIME EVENT PAYLOAD TYPES (convenience re-exports for consumers)
// ============================================================================

export type { ImportFileProgressEvent } from "@synap-core/types/events";

// Note: SynapEvent schema and event metadata types are in @synap-core/core
// to break the circular dependency between the database and events packages.
