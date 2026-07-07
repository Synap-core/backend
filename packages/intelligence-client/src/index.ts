export {
  IntelligenceHubClient,
  AgentHubClient,
  intelligenceHubClient,
  IntelligenceAuthError,
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
  ImportAnalysisPlan,
  ColumnMappingProposal,
  FollowUpChip,
  StructuredFollowUp,
  DynamicFormField,
  DynamicFormSpec,
} from "./intelligence-hub-client.js";

export {
  resolveIntelligenceService,
  resolveIntelligenceServiceByAgentId,
  resolveAgent,
  getDefaultActiveService,
  setDefaultIntelligenceService,
} from "./intelligence-routing.js";

export type {
  ServiceResolutionContext,
  ResolvedService,
} from "./intelligence-routing.js";

export { resolveAgentForTask } from "./agent-routing.js";

export type { AgentResolutionContext, ResolvedAgent } from "./agent-routing.js";

export { iterateISChatStream, drainISChatStream } from "./is-chat-stream.js";

export type { ISChatStreamFrame } from "./is-chat-stream.js";

export {
  requestHeadlessChatText,
  requestTaskExecute,
} from "./is-headless-transport.js";

export type {
  HeadlessChatRequest,
  HeadlessTaskExecuteRequest,
} from "./is-headless-transport.js";
