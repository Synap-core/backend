/**
 * Chat Types - Domain Model
 *
 * Chat-related types for Synap's channel-based messaging with branching.
 * Leverages database-generated types and Hub Protocol types.
 */

import type {
  AIStep,
  ExtractedEntity,
  BranchDecision,
  AgentTypeString,
  MessageMetadata,
  CreatedProposal,
} from "../hub-protocol/index.js";

// =============================================================================
// Database Types (Re-exported from Drizzle schema)
// =============================================================================

/**
 * Channel (conversation container — was ChatThread)
 *
 * Generated from database schema - DO NOT manually define
 */
export type { Channel, NewChannel } from "@synap/database";

/**
 * Message (was ChatMessage / ConversationMessageRow)
 *
 * Generated from database schema - DO NOT manually define
 */
export type {
  MessageRow as ChatMessage,
  NewMessageRow as NewChatMessage,
} from "@synap/database";

/**
 * Channel context item (replaces ThreadEntity + ThreadDocument)
 *
 * Generated from database schema - DO NOT manually define
 */
export type {
  ChannelContextItem,
  NewChannelContextItem,
} from "@synap/database";

// =============================================================================
// UI State Types
// =============================================================================

/**
 * Branch node for UI tree visualization
 */
export interface BranchNode {
  id: string;
  channelId: string;
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
 * Chat UI state for components (streaming + completed message)
 */
export interface ChatUIState {
  isStreaming: boolean;
  currentContent: string;
  aiSteps: AIStep[];
  extractedEntities: ExtractedEntity[];
  /** In-stream action proposals (create/update entity or document) */
  proposedActions?: CreatedProposal[];
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
  /** Active workspace (for entity create/update – event chain). Sent by frontend when available. */
  workspaceId?: string;
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
  parentChannelId: string;
  branchedFromMessageId: string;
  agentType: AgentTypeString;
  title?: string;
  purpose?: string;
}

/**
 * Create branch response
 */
export interface CreateBranchResponse {
  channelId: string;
  channel: any; // Channel type
}

// =============================================================================
// Hook Result Types (for frontend reference)
// =============================================================================

/**
 * useChatChannel hook result
 */
export interface UseChatThreadResult {
  channel: any; // Channel | undefined
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
  proposedActions?: CreatedProposal[];
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
