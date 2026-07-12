/**
 * Jobs Package - Main Export
 *
 * V3.0: pg-boss based job queue (replaced Inngest)
 *
 * This package exports:
 * - pg-boss client (start/stop/getBoss) - re-exported from @synap/events
 * - Side-effect emitter (emitSideEffects) - re-exported from @synap/events
 * - Worker registry for admin UI
 * - Unified event types (re-exports from @synap-core/types)
 * - Realtime broadcast utilities
 */

// pg-boss client and lifecycle - re-exported from @synap/events
export { getBoss, startBoss, stopBoss, emitSideEffects } from "@synap/events";

// Cron scheduler
export { registerCronSchedules } from "./cron.js";

// Worker registration
export { registerAllWorkers } from "./workers/index.js";

// Worker registry (admin UI metadata)
export * from "./worker-registry.js";

// Realtime broadcast utilities
export * from "./utils/realtime-broadcast.js";

// Unified event types (used by audit-log, event-stream-manager, etc.)
export * from "./types/index.js";

// A2AI response trigger job queue constants (imported by @synap/api hub-protocol router)
export {
  A2AI_TRIGGER_QUEUE,
  A2AI_TRIGGER_JOB_OPTIONS,
  type A2AIResponseTriggerData,
} from "./workers/a2ai-response-trigger.js";

// Local sync driver — pg-boss-independent interval loop for LOCAL_MODE (Electron pod)
export {
  startLocalSyncDriver,
  stopLocalSyncDriver,
} from "./workers/local-sync-driver.js";

// CP catalog sync — kind vocabulary (imported by @synap/api's catalog-cache-query.ts)
export { type CatalogKind } from "./workers/cp-catalog-sync.js";
