/**
 * @synap/hub-protocol
 *
 * Hub Protocol V1.0 - Standardized schemas for Hub ↔ Data Pod communication
 *
 * This package provides:
 * - Type-safe schemas (Zod) for Hub insights
 * - Validation functions
 * - TypeScript types
 *
 * @example
 * ```typescript
 * import { HubInsightSchema, validateHubInsight } from '@synap/hub-protocol';
 *
 * const insight = validateHubInsight({
 *   version: '1.0',
 *   type: 'action_plan',
 *   correlationId: 'req-123',
 *   actions: [...],
 *   confidence: 0.95,
 * });
 * ```
 */

// Export schemas
export { HubInsightSchema, ActionSchema, AnalysisSchema } from "./schemas.js";

// Export types
export type { HubInsight, Action, Analysis } from "./schemas.js";

// Export validation functions
export {
  validateHubInsight,
  validateAction,
  validateAnalysis,
} from "./schemas.js";

// Export type guards
export { isActionPlan, isAnalysis } from "./schemas.js";

// ============================================================================
// HUB PROTOCOL CLIENT (tRPC Client for Data Pod Communication)
// ============================================================================

export { HubProtocolClient } from "./client/client.js";
export type {
  HubProtocolClientConfig,
  HubScope,
  RequestDataFilters,
} from "./client/types.js";
