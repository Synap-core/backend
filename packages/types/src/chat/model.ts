/**
 * Chat rows on the wire — channels, messages, channel context items.
 *
 * The row interfaces are declared HERE, once: `@synap/database` imports and
 * re-exports them. The string unions below mirror the database's runtime
 * `as const` objects (`ChannelType.THREAD`, …), which stay with the tables;
 * the database proves each union equal to its const
 * (`packages/database/src/wire-parity/chat.ts`). Plain string literal unions,
 * so "user" is directly assignable to `MessageRole`, "active" to
 * `ChannelStatus`, etc. Pure types: nothing from the database package.
 */

// ── Channels ────────────────────────────────────────────────────────────────

/** `channels.channel_type`. */
export type ChannelType =
  | "thread"
  | "personal"
  | "sub_thread"
  | "feed"
  | "external"
  | "agent_collab"
  | "group"
  | "run";

/** `channels.scope` — visibility, orthogonal to type. */
export type ChannelScope = "pod" | "workspace" | "user";

/** `channels.feed_scope` (FEED channels only). */
export type FeedScope = "user" | "workspace";

/** `channels.status`. */
export type ChannelStatus = "active" | "merged" | "archived";

/** Which AI agent handles a channel's messages (free string at the DB level). */
export type ChannelAgentType =
  | "orchestrator"
  | "meta"
  | "personal"
  | "prompting"
  | "knowledge-search"
  | "code"
  | "writing"
  | "action"
  | "onboarding"
  | "workspace-creation"
  | "insight-discovery"
  | "view-builder"
  | "workspace-builder"
  | "none";

/** Per-channel "how do AI teammates react" control (multiplayer channels). */
export type AiReactionMode = "only_mentioned" | "when_confident" | "off";

// ── Messages ────────────────────────────────────────────────────────────────

/** Semantic role of the message author in the conversation. */
export type MessageRole = "user" | "assistant" | "system";

/** Who actually produced the message. */
export type MessageAuthorType = "human" | "ai_agent" | "external" | "bot";

/** What kind of interaction the message represents. */
export type MessageCategory =
  "chat" | "comment" | "system_notification" | "review";

/** How an AI teammate came to author a message in a multiplayer room. */
export type RoutedSource = "orchestrator" | "mention" | "direct";

// ── Channel context items ───────────────────────────────────────────────────

/** The type of object tracked in a context item. */
export type ChannelContextObjectType =
  "entity" | "document" | "view" | "proposal" | "inbox_item";

/** How the object relates to the channel. */
export type ChannelContextRelationshipType =
  | "used_as_context"
  | "created"
  | "updated"
  | "referenced"
  | "inherited_from_parent";

/** Conflict status (for parallel branch workflows). */
export type ChannelContextConflictStatus = "none" | "pending" | "resolved";

// ── Rows ────────────────────────────────────────────────────────────────────

/** Channel row — explicit interface so consumers don't need drizzle-orm to resolve it. */
export interface Channel {
  id: string;
  userId: string;
  workspaceId: string | null;
  projectId: string | null;
  title: string | null;
  channelType: ChannelType;
  scope: ChannelScope;
  feedScope: FeedScope | null;
  contextObjectType: string | null;
  contextObjectId: string | null;
  parentChannelId: string | null;
  branchedFromMessageId: string | null;
  branchPurpose: string | null;
  aiReactionMode: AiReactionMode;
  assignedAgentId: string | null;
  senderAgentId: string | null;
  status: ChannelStatus;
  contextSummary: string | null;
  resultSummary: string | null;
  mergedIntoStateId: string | null;
  externalSource: string | null;
  externalChannelId: string | null;
  externalId: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  mergedAt: Date | null;
}
export type NewChannel = Partial<
  Omit<Channel, "id" | "createdAt" | "updatedAt">
> & {
  userId: string;
};

/** Message row — explicit interface so consumers don't need drizzle-orm to resolve it. */
export interface MessageRow {
  id: string;
  channelId: string;
  parentId: string | null;
  role: MessageRole;
  authorType: MessageAuthorType;
  messageCategory: MessageCategory;
  externalSource: string | null;
  inboxItemId: string | null;
  content: string;
  /** Typed as unknown to avoid pulling in @synap-core/core across package boundaries. */
  metadata: unknown;
  routedTeammateId: string | null;
  routedSource: RoutedSource | null;
  userId: string;
  timestamp: Date;
  previousHash: string | null;
  hash: string;
  sessionId: string | null;
  deletedAt: Date | null;
  editedAt: Date | null;
  ephemeral: boolean;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}
export type NewMessageRow = Partial<
  Omit<MessageRow, "id" | "timestamp" | "hash">
> & {
  channelId: string;
  content: string;
  userId: string;
  role: MessageRole;
};

/** Channel context item row — explicit interface so consumers don't need drizzle-orm. */
export interface ChannelContextItem {
  id: string;
  channelId: string;
  objectType: ChannelContextObjectType;
  objectId: string;
  relationshipType: ChannelContextRelationshipType;
  conflictStatus: ChannelContextConflictStatus;
  sourceMessageId: string | null;
  relevanceScore: number | null;
  userId: string;
  workspaceId: string | null;
  createdAt: Date;
}
export type NewChannelContextItem = Partial<
  Omit<ChannelContextItem, "id" | "createdAt">
> & {
  channelId: string;
  objectType: ChannelContextObjectType;
  objectId: string;
  relationshipType: ChannelContextRelationshipType;
  userId: string;
  workspaceId?: string | null;
};
