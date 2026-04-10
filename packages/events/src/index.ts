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

// Note: SynapEvent schema and event metadata types are in @synap-core/core
// to break the circular dependency between the database and events packages.
