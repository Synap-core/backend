/**
 * @synap/ai - AI Integration Package (Data Pod)
 * 
 * Framework package for tool registry, conversational agents, and LangGraph architecture.
 * Enables plugin extensibility without proprietary Intelligence Hub code.
 * 
 * Provides:
 * - dynamicToolRegistry: Register and execute tools
 * - ConversationalAgent: Base class for conversational agents
 * - LangGraph helpers: Utilities for building agents
 * - Tool types: TypeScript interfaces for tool development
 * - Agent types: TypeScript interfaces for agent development
 */

// Tool Registry
export { dynamicToolRegistry } from './tools/dynamic-registry.js';
export type { AgentToolDefinition } from './tools/types.js';

// Conversational Agent
export { ConversationalAgent } from './agent/conversational-agent.js';
export type { 
  ConversationMessage,
  ConversationContext,
  ConversationResponse,
} from './agent/conversational-agent.js';

// LangGraph Helpers
export {
  CommonStateFields,
  StateGraph,
  START,
  END,
  Annotation,
} from './agent/langgraph-helpers.js';

// Agent Types (for advanced use)
export type {
  AgentIntent,
  IntentAnalysis,
  ConversationSnippet,
  SemanticSearchResult,
  MemoryFact,
  AgentContext,
  PlannedAction,
  AgentActionPlan,
  AgentPlanSummary,
 ActionExecutionStatus,
  ActionExecutionLog,
} from './agent/types.js';
