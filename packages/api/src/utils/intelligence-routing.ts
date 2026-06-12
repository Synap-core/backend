/**
 * Intelligence Service Routing — re-exported from @synap/intelligence-client
 *
 * The canonical implementation lives in packages/intelligence-client so that
 * packages/jobs can also import it without a circular dependency.
 */
export {
  resolveIntelligenceService,
  resolveIntelligenceServiceByAgentId,
  resolveAgent,
  getDefaultActiveService,
  IntelligenceAuthError,
} from "@synap/intelligence-client";

export type {
  ServiceResolutionContext,
  ResolvedService,
} from "@synap/intelligence-client";

export { resolveAgentForTask } from "@synap/intelligence-client";

export type {
  AgentResolutionContext,
  ResolvedAgent,
} from "@synap/intelligence-client";
