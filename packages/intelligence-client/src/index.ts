export {
  IntelligenceHubClient,
  AgentHubClient,
  intelligenceHubClient,
} from "./intelligence-hub-client.js";

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
} from "./intelligence-hub-client.js";

export {
  resolveIntelligenceService,
  resolveAgent,
  getDefaultActiveService,
} from "./intelligence-routing.js";

export type {
  ServiceResolutionContext,
  ResolvedService,
} from "./intelligence-routing.js";
