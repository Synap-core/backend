/**
 * Jobs Package - Main Export
 *
 * V3.0: pg-boss based job queue (replaced Inngest)
 *
 * This package exports:
 * - pg-boss client (start/stop/getBoss)
 * - Side-effect emitter (emitSideEffects)
 * - Worker registry for admin UI
 * - Unified event types (re-exports from @synap-core/types)
 * - Realtime broadcast utilities
 */

// pg-boss client and lifecycle
export { getBoss, startBoss, stopBoss } from "./boss.js";

// Side-effect emitter (fire-and-forget after synchronous CRUD)
export { emitSideEffects } from "./emit-side-effects.js";

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
