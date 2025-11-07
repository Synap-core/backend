export type AgentIntent = 'capture' | 'command' | 'query' | 'unknown';

export interface IntentAnalysis {
  label: AgentIntent;
  confidence: number;
  reasoning: string;
  needsFollowUp: boolean;
}

export interface ConversationSnippet {
  role: 'user' | 'assistant';
  content: string;
}

export interface SemanticSearchResult {
  entityId: string;
  title: string;
  type: string;
  preview?: string;
  fileUrl?: string;
  relevanceScore: number;
}

export interface MemoryFact {
  factId: string;
  fact: string;
  confidence: number;
  sourceEntityId?: string;
  sourceMessageId?: string;
}

export interface AgentContext {
  semanticResults: SemanticSearchResult[];
  recentMessages: ConversationSnippet[];
  memoryFacts: MemoryFact[];
}

export interface PlannedAction {
  tool: string;
  params: Record<string, unknown>;
  justification?: string;
}

export interface AgentActionPlan {
  actions: PlannedAction[];
}

export interface AgentPlanSummary extends AgentActionPlan {
  reasoning: string;
}

export type ActionExecutionStatus = 'success' | 'error' | 'skipped';

export interface ActionExecutionLog {
  tool: string;
  params: Record<string, unknown>;
  status: ActionExecutionStatus;
  result?: unknown;
  errorMessage?: string;
}

