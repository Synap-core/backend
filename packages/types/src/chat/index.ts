/**
 * Chat Types - Domain Model
 *
 * Chat-related types for Synap's infinite chat with branching.
 * Leverages database-generated types and Hub Protocol types.
 */

import type {
  AIStep,
  ExtractedEntity,
  BranchDecision,
  AgentTypeString,
  MessageMetadata,
} from "../hub-protocol/index.js";

// =============================================================================
// Database Types (Re-exported from Drizzle schema)
// =============================================================================

/**
 * Chat thread (conversation)
 *
 * Generated from database schema - DO NOT manually define
 */
export type {
  ChatThread,
  NewChatThread,
} from "../../../database/src/schema/index.js";

/**
 * Chat message
 *
 * Generated from database schema - DO NOT manually define
 */
export type {
  ConversationMessageRow as ChatMessage,
  NewConversationMessageRow as NewChatMessage,
} from "../../../database/src/schema/index.js";

// =============================================================================
// UI State Types
// =============================================================================

/**
 * Branch node for UI tree visualization
 */
export interface BranchNode {
  id: string;
  threadId: string;
  parentId?: string;
  children: string[];
  depth: number;
  agentType: AgentTypeString;
  status: "active" | "archived" | "merged";
  title?: string;
  branchPurpose?: string;
  createdAt: string;
  mergedAt?: string;
}

/**
 * Chat UI state for components
 */
export interface ChatUIState {
  isStreaming: boolean;
  currentContent: string;
  aiSteps: AIStep[];
  extractedEntities: ExtractedEntity[];
  branchDecision?: BranchDecision;
  error?: string;
}

// =============================================================================
// Request/Response Types (tRPC)
// =============================================================================

/**
 * Send message request
 */
export interface SendMessageRequest {
  threadId: string;
  content: string;
  agentType?: AgentTypeString;
  agentConfig?: Record<string, unknown>;
}

/**
 * Send message response
 */
export interface SendMessageResponse {
  messageId: string;
  content: string;
  metadata?: MessageMetadata;
}

/**
 * Create branch request
 */
export interface CreateBranchRequest {
  parentThreadId: string;
  branchedFromMessageId: string;
  agentType: AgentTypeString;
  title?: string;
  purpose?: string;
}

/**
 * Create branch response
 */
export interface CreateBranchResponse {
  threadId: string;
  thread: any; // ChatThread type
}

// =============================================================================
// Hook Result Types (for frontend reference)
// =============================================================================

/**
 * useChatThread hook result
 */
export interface UseChatThreadResult {
  thread: any; // ChatThread | undefined
  messages: any[]; // ChatMessage[]
  isLoading: boolean;
  error: Error | null;
  sendMessage: (content: string) => Promise<void>;
  createBranch: (
    messageId: string,
    agentType: AgentTypeString
  ) => Promise<string>;
}

/**
 * useStreamingMessage hook result
 */
export interface UseStreamingMessageResult {
  content: string;
  aiSteps: AIStep[];
  entities: ExtractedEntity[];
  branchDecision?: BranchDecision;
  isStreaming: boolean;
  error?: string;
}

/**
 * useAISteps hook result
 */
export interface UseAIStepsResult {
  steps: AIStep[];
  currentStep?: AIStep;
  isThinking: boolean;
}

/**
 * useBranchTree hook result
 */
export interface UseBranchTreeResult {
  nodes: BranchNode[];
  rootNode?: BranchNode;
  currentNode?: BranchNode;
  isLoading: boolean;
}
