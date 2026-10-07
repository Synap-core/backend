/**
 * Intelligence Service Routing — re-exported from @synap/intelligence-client
 *
 * The canonical implementation lives in packages/intelligence-client so that
 * packages/jobs can also import it without a circular dependency.
 */
export {
  resolveIntelligenceService,
  resolveAgent,
  getDefaultActiveService,
  setDefaultIntelligenceService,
  selectPodDefaultService,
  selectIntelligenceService,
  envIntelligenceEndpoint,
  describeServingIntelligence,
  IntelligenceAuthError,
} from "@synap/intelligence-client";

export type {
  ServiceResolutionContext,
  ResolvedService,
  IntelligenceSelection,
  IntelligenceSelectionVia,
  ServingIntelligence,
} from "@synap/intelligence-client";
