/**
 * @initiativ/core
 * Main orchestrator for Initiativ Core
 * 
 * Brings together all subsystems:
 * - Input processing
 * - Storage (files + cache)
 * - RAG (semantic search)
 * - Memory (fact extraction)
 * - Agents (AI orchestration)
 * - Git (versioning)
 * 
 * Implements "Chain of Thoughts" with conversation branching
 */

export { InitiativCore } from './system.js';
export { Workflows } from './workflows.js';
export { ChatManager } from './chat.js';

export type {
  CoreConfig,
  CaptureOptions,
  SearchOptions,
  Insight,
  ChatThread,
  ChatMessage,
  BranchSummary
} from './types.js';

