export * from "./types/agent-state.js";
export * from "./logger.js";
export * from "./config.js";
export * from "./errors.js";
// `./tracing.js` is deliberately NOT re-exported: nothing calls it yet, and the
// barrel is also read through `@synap/database`'s types by source-mapped
// consumers (relay-app's tsc), which then had to resolve the Node-only
// OpenTelemetry SDK. Enabling tracing = give it its own `exports` subpath.
export * from "./metrics.js";

// ============================================================================
// EVENT SCHEMA & VALIDATION (moved from @synap/types)
// ============================================================================

export {
  SynapEventSchema,
  type SynapEvent,
  EventTypeSchemas,
  type EventTypeWithSchema,
  validateEventData,
  createSynapEvent,
  parseSynapEvent,
} from "./synap-event.js";

// Event metadata types (AI, import, sync, automation)
export * from "./event-metadata.js";

// Enhanced event metadata (validation, user, message, IoT, enterprise)
export * from "./enhanced-event-metadata.js";

// Enhanced message metadata (AI, approval, links, attachments)
export * from "./enhanced-message-metadata.js";
