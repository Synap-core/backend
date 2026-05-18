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
// Database Types — Re-exported from @synap/database (single source of truth)
//
// @synap/database uses const objects instead of TypeScript enums, so these
// types are plain string literal unions — "user" is directly assignable to
// MessageRole, "active" to ChannelStatus, etc.
// =============================================================================

export type {
  Channel,
  NewChannel,
  ChannelType,
  ChannelScope,
  FeedScope,
  ChannelStatus,
  ChannelAgentType,
} from "@synap/database";

export type {
  MessageRow as ChatMessage,
  NewMessageRow as NewChatMessage,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database";

export type {
  ChannelContextItem,
  NewChannelContextItem,
  ChannelContextObjectType,
  ChannelContextRelationshipType,
  ChannelContextConflictStatus,
} from "@synap/database";

// =============================================================================
// Backward-compatible string-union aliases
// These alias the database types (now identical — string literal unions).
// =============================================================================

import type {
  Channel,
  ChannelType,
  ChannelStatus,
  MessageRole,
  MessageAuthorType,
  MessageCategory,
} from "@synap/database";

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
 * AI channel family describes structural routing, not product labels.
 * - personal: user's pod-wide personal AI channel
 * - context: channel anchored to a concrete context object (entity/document/view)
 * - branch: branch channel with a parent channel
 */
export const AI_CHANNEL_FAMILY_VALUES = [
  "agent",
  "workspace_group",
  "context",
  "branch",
] as const;

export type AIChannelFamily = (typeof AI_CHANNEL_FAMILY_VALUES)[number];

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
