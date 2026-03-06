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
// Database Types — Standalone interfaces (string literal unions, no DB enums)
// =============================================================================

/**
 * Channel (conversation container — was ChatThread)
 *
 * Standalone interface with string literal union types so frontend code
 * can use plain strings without importing TypeScript enums from @synap/database.
 */
export interface Channel {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  channelType: ChannelTypeString;
  contextObjectType: string | null;
  contextObjectId: string | null;
  parentChannelId: string | null;
  branchedFromMessageId: string | null;
  branchPurpose: string | null;
  agentId: string;
  status: ChannelStatusString;
  agentType: string;
  agentConfig: unknown;
  contextSummary: string | null;
  resultSummary: string | null;
  mergedIntoStateId: string | null;
  externalSource: string | null;
  externalChannelId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
}

/** New channel input — most fields optional (DB provides defaults) */
export type NewChannel = Partial<Channel> &
  Pick<Channel, "userId" | "channelType">;

/**
 * Message (was ChatMessage / ConversationMessageRow)
 *
 * Standalone interface with string literal union types so frontend code
 * can use `role: "user"` without importing MessageRole enum from @synap/database.
 */
export interface ChatMessage {
  id: string;
  channelId: string;
  parentId: string | null;
  role: MessageRoleString;
  authorType: MessageAuthorTypeString;
  messageCategory: MessageCategoryString;
  externalSource: string | null;
  inboxItemId: string | null;
  content: string;
  metadata: unknown;
  userId: string;
  timestamp: Date;
  previousHash: string | null;
  hash: string;
  sessionId: string | null;
  deletedAt: Date | null;
}

/** New message input */
export type NewChatMessage = Partial<ChatMessage> &
  Pick<ChatMessage, "channelId" | "content" | "userId" | "role">;

/**
 * Channel context item (replaces ThreadEntity + ThreadDocument)
 */
export interface ChannelContextItem {
  id: string;
  channelId: string;
  objectType: string;
  objectId: string;
  relationshipType: string;
  userId: string;
  workspaceId: string | null;
  createdAt: Date;
}

export type NewChannelContextItem = Partial<ChannelContextItem> &
  Pick<ChannelContextItem, "channelId" | "objectType" | "objectId">;

// =============================================================================
// Channel & Message Enum Types
//
// Single source of truth for all string unions derived from the DB schema enums.
// Frontend imports these instead of redefining them locally.
// =============================================================================

/** Channel type — maps to `channel_type` column */
export type ChannelTypeString =
  | "ai_thread"
  | "branch"
  | "entity_comments"
  | "document_review"
  | "view_discussion"
  | "direct"
  | "external_import"
  | "a2ai";

/** Channel status — maps to `status` column */
export type ChannelStatusString = "active" | "merged" | "archived";

/** Message role — maps to `role` column */
export type MessageRoleString = "user" | "assistant" | "system";

/** Message author type — maps to `author_type` column */
export type MessageAuthorTypeString = "human" | "ai_agent" | "external" | "bot";

/** Message category — maps to `message_category` column */
export type MessageCategoryString =
  | "chat"
  | "comment"
  | "system_notification"
  | "review";

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
