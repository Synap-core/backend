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

export type {
  ISChatStreamFrame,
  DrainISChatStreamOptions,
  DrainISChatStreamResult,
} from "./is-chat-stream.js";

export {
  requestHeadlessChatText,
  requestTaskExecute,
} from "./is-headless-transport.js";

export type {
  HeadlessChatRequest,
  HeadlessTaskExecuteRequest,
} from "./is-headless-transport.js";

// IS call budgets + attributed failures — the SSOT every backend→IS fetch uses
// for its timeout and its failure message (see is-call-budget.ts for the
// 2026-07-31 incident that motivated it).
export {
  isCallBudgetMs,
  describeISFailure,
  describeISHttpError,
  describeISEmptyGeneration,
} from "./is-call-budget.js";

export type { ISCallKind, ISCallContext } from "./is-call-budget.js";

// AI usage/finish-reason capture — the side channel that carries an IS
// generation's `usage` + `finishReason` to the automation step ledger WITHOUT
// touching the `ai.generate` output contract (see ai-usage-collector.ts).
export {
  AiUsageCollector,
  beginAiUsageCapture,
  withAiUsageCapture,
  recordAiUsage,
  currentAiUsage,
} from "./ai-usage-collector.js";

export type { AiUsageSample, AiUsageTotals } from "./ai-usage-collector.js";
