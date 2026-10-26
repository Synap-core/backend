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
// Row Types — declared in ./model.js (the wire shape). @synap/database
// re-exports these row interfaces and proves the unions equal to its runtime
// `as const` objects. Plain string literal unions — "user" is directly
// assignable to MessageRole, "active" to ChannelStatus, etc.
// =============================================================================

export type {
  Channel,
  NewChannel,
  ChannelType,
  ChannelScope,
  FeedScope,
  ChannelStatus,
  ChannelAgentType,
} from "./model.js";

export type {
  MessageRow as ChatMessage,
  NewMessageRow as NewChatMessage,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "./model.js";

export type {
  ChannelContextItem,
  NewChannelContextItem,
  ChannelContextObjectType,
  ChannelContextRelationshipType,
  ChannelContextConflictStatus,
} from "./model.js";

// =============================================================================
// Backward-compatible string-union aliases
// =============================================================================

import type {
  Channel,
  ChannelType,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "./model.js";

export type ChannelTypeString = ChannelType;
export type ChannelStatusString = ChannelStatus;
export type MessageRoleString = MessageRole;
export type MessageAuthorTypeString = MessageAuthorType;
export type MessageCategoryString = MessageCategory;

// =============================================================================
// UI State Types
// =============================================================================

/**
 * Branch node for UI tree visualization.
 *
 * Matches the nested structure returned by `getBranchTree` tRPC procedure.
 * Each node wraps a full Channel and its recursive children.
 */
export interface BranchNode {
  channel: Channel;
  children: BranchNode[];
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
  channel: Channel;
}

// =============================================================================
// Hook Result Types (for frontend reference)
// =============================================================================

/**
 * useChatThread hook result
 */
export interface UseChatThreadResult {
  thread: Channel | undefined;
  isLoading: boolean;
  error: Error | null;
  createBranch: (
    purpose: string,
    agentType?: AgentTypeString
  ) => Promise<Channel>;
  mergeBranch: (branchId: string) => Promise<void>;
  updateThread: (updates: {
    title?: string;
    branchPurpose?: string;
    agentType?: AgentTypeString;
    agentConfig?: Record<string, unknown>;
  }) => Promise<void>;
  archiveThread: () => Promise<void>;
}

/**
 * useStreamingMessage hook result
 */
export interface UseStreamingMessageResult {
  streamingContent: string;
  streamingSteps: AIStep[];
  isStreaming: boolean;
  currentStep: AIStep | null;
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
 * useBranches hook result
 */
export interface UseBranchesResult {
  branchTree: BranchNode | null;
  flatBranches: Channel[];
  activeBranches: Channel[];
  mergedBranches: Channel[];
  isLoading: boolean;
}
