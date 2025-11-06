/**
 * @initiativ/agents
 * AI Agents for Initiativ Core
 * 
 * Provides:
 * - LangChain agent orchestration with tools
 * - Simple enrichment methods (tags, titles) without LangChain overhead
 * - Claude integration
 */

// Export types
export type {
  AgentConfig,
  ToolResult,
  AgentResponse,
  ToolCall
} from './types.js';

// Export tools
export {
  createSearchNotesTool,
  createCreateNoteTool,
  createBranchTool,
  createMergeBranchTool
} from './tools.js';

// Export orchestrator
export { AgentOrchestrator } from './orchestrator.js';

