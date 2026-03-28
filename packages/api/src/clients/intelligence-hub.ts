/**
 * Intelligence Hub Client — re-exported from @synap/intelligence-client
 *
 * The canonical implementation lives in packages/intelligence-client so that
 * packages/jobs can also import it without a circular dependency.
 */
export {
  IntelligenceHubClient,
  AgentHubClient,
  intelligenceHubClient,
} from "@synap/intelligence-client";

export type {
  McpServerConfig,
  IntelligenceHubRequest,
  IntelligenceHubResponse,
  AgentHubRequest,
  AgentHubResponse,
  HubResponse,
  ExtractedEntity,
  BranchDecision,
  TokenUsage,
  AIStep,
  CreatedProposal,
} from "@synap/intelligence-client";
