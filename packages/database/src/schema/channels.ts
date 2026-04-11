/**
 * Channels Schema — V2
 *
 * A channel is a conversation surface with a context scope.
 * 6 canonical types replace the previous 9.
 * `channelPurpose` is removed — absorbed into channelType.
 * `scope` and `feedScope` are new.
 *
 * See docs/CHANNEL-SYSTEM.md for the full design spec.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * Channel Types (V2)
 *
 * PERSONAL     — The user's permanent AI assistant channel (pod-wide, one per user).
 *                Was: ai_thread + channelPurpose=chat
 * THREAD       — A conversation linked to a specific context object.
 *                Replaces: ai_thread (free-form), entity_comments, document_review, view_discussion.
 *                contextObjectType determines what the conversation is about.
 * SUB_THREAD   — A specialized sub-agent task spawned within a parent channel.
 *                Always has parentChannelId. AI always active with a specific agent persona.
 *                Was: branch (and the unimplemented thread type)
 * FEED         — Proactive AI broadcast channel. AI posts, users read.
 *                feedScope determines user-level vs workspace-level.
 *                Was: ai_thread + channelPurpose=feed
 * EXTERNAL     — Ingested conversation from an external platform (WhatsApp, Slack, Gmail, etc.)
 *                Was: external_import
 * AGENT_COLLAB — Internal multi-agent collaboration channel (persistent, workspace-scoped).
 *                Distinct from Google A2A (ephemeral, cross-system task delegation).
 *                Was: a2ai
 */
export const ChannelType = {
  PERSONAL: "personal",
  THREAD: "thread",
  SUB_THREAD: "sub_thread",
  FEED: "feed",
  EXTERNAL: "external",
  AGENT_COLLAB: "agent_collab",
} as const;
export type ChannelType = (typeof ChannelType)[keyof typeof ChannelType];

/**
 * Channel Scope
 *
 * Controls visibility and filtering. Orthogonal to type.
 *
 * pod       — Visible across all workspaces (personal channel, user feed)
 * workspace — Scoped to a single workspace (thread, external, agent_collab)
 * user      — Reserved for future user-scoped surfaces
 */
export const ChannelScope = {
  POD: "pod",
  WORKSPACE: "workspace",
  USER: "user",
} as const;
export type ChannelScope = (typeof ChannelScope)[keyof typeof ChannelScope];

/**
 * Feed Scope (only for FEED type)
 *
 * user      — Personal proactive feed: morning briefing, insights, capture summaries
 * workspace — Workspace-wide feed: connector sync, automation results, team digests
 */
export const FeedScope = {
  USER: "user",
  WORKSPACE: "workspace",
} as const;
export type FeedScope = (typeof FeedScope)[keyof typeof FeedScope];

/**
 * Channel Status
 */
export const ChannelStatus = {
  ACTIVE: "active",
  MERGED: "merged",
  ARCHIVED: "archived",
} as const;
export type ChannelStatus = (typeof ChannelStatus)[keyof typeof ChannelStatus];

/**
 * Channel Agent Types
 *
 * Determines which AI agent handles messages in this channel.
 * Free string at DB level — IS handles unknown values gracefully (falls back to OrchestratorAgent).
 */
export const ChannelAgentType = {
  // Workspace-generalist co-founder AI (canonical alias: META)
  ORCHESTRATOR: "orchestrator",
  // "meta" is the public-facing name users/frontend see; both route to OrchestratorAgent
  META: "meta",
  // Personal assistant: user-centric, memory-first. Used for personal channels only.
  PERSONAL: "personal",
  PROMPTING: "prompting",
  KNOWLEDGE_SEARCH: "knowledge-search",
  CODE: "code",
  WRITING: "writing",
  ACTION: "action",
  ONBOARDING: "onboarding",
  WORKSPACE_CREATION: "workspace-creation", // legacy key
  // Specialists
  INSIGHT_DISCOVERY: "insight-discovery",
  VIEW_BUILDER: "view-builder",
  WORKSPACE_BUILDER: "workspace-builder",
  // AI inactive — was DEFAULT (renamed to be unambiguous: "default" implied AI on, but it suppressed it)
  NONE: "none",
} as const;
export type ChannelAgentType =
  (typeof ChannelAgentType)[keyof typeof ChannelAgentType];

export const channels = pgTable(
  "channels",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Workspace scope for listing/filtering; null = pod-scoped channel (personal, user feed). */
    workspaceId: uuid("workspace_id"),

    // Channel metadata
    title: text("title"),
    channelType: text("channel_type", {
      enum: [
        ChannelType.PERSONAL,
        ChannelType.THREAD,
        ChannelType.SUB_THREAD,
        ChannelType.FEED,
        ChannelType.EXTERNAL,
        ChannelType.AGENT_COLLAB,
      ],
    })
      .notNull()
      .default(ChannelType.THREAD),

    /**
     * Scope controls visibility across workspaces.
     * personal → pod, thread/external/agent_collab → workspace, feed → pod or workspace.
     */
    scope: text("scope", {
      enum: [ChannelScope.POD, ChannelScope.WORKSPACE, ChannelScope.USER],
    })
      .notNull()
      .default(ChannelScope.WORKSPACE),

    /**
     * Feed scope — only set for FEED type channels.
     * user = personal proactive feed; workspace = team-wide shared feed.
     */
    feedScope: text("feed_scope", {
      enum: [FeedScope.USER, FeedScope.WORKSPACE],
    }),

    // Context: what object this channel is "about"
    // Canonical contextObjectType values: workspace | entity | document | view |
    //   project | task | user | external
    contextObjectType: text("context_object_type"),
    contextObjectId: uuid("context_object_id"),

    // Sub-thread hierarchy (for SUB_THREAD channels)
    parentChannelId: uuid("parent_channel_id"), // Self-reference to channels.id
    branchedFromMessageId: uuid("branched_from_message_id"), // Reference to messages.id
    branchPurpose: text("branch_purpose"), // Task description for the sub-thread

    // Agent assignment
    agentId: text("agent_id").notNull().default("orchestrator"),

    // Status
    status: text("status", {
      enum: [
        ChannelStatus.ACTIVE,
        ChannelStatus.MERGED,
        ChannelStatus.ARCHIVED,
      ],
    })
      .notNull()
      .default(ChannelStatus.ACTIVE),

    // Agent type for multi-agent system — free string, no DB-level enum constraint.
    // Use ChannelAgentType.NONE to disable AI. All typed channels (personal, sub_thread,
    // agent_collab) always have AI active regardless of this field.
    agentType: text("agent_type").notNull().default(ChannelAgentType.NONE),

    agentConfig: jsonb("agent_config"), // Custom agent configuration (system prompt, tools, etc.)

    /** MCP servers enabled for this channel. null = inherit no MCPs (opt-in model). */
    mcpServerIds: uuid("mcp_server_id").array(),

    // Context (compressed summaries from merged sub-threads)
    contextSummary: text("context_summary"),

    // Sub-thread result tracking (only populated for SUB_THREAD channels)
    resultSummary: text("result_summary"),
    mergedIntoStateId: uuid("merged_into_state_id"), // FK to compacted_states (circular dep — set in migration)

    // External source (for EXTERNAL channels)
    externalSource: text("external_source"), // 'whatsapp' | 'slack' | 'gmail' | 'telegram' | 'sms'
    externalChannelId: text("external_channel_id"), // ID of conversation in external system

    // Metadata
    metadata: jsonb("metadata"),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    mergedAt: timestamp("merged_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    userIdIdx: index("channels_user_id_idx").on(table.userId),
    workspaceIdIdx: index("channels_workspace_id_idx").on(table.workspaceId),
    parentChannelIdx: index("channels_parent_channel_id_idx").on(
      table.parentChannelId
    ),
    statusIdx: index("channels_status_idx").on(table.status),
    contextIdx: index("channels_context_idx").on(
      table.contextObjectType,
      table.contextObjectId
    ),
    scopeIdx: index("channels_scope_idx").on(table.scope),
    typeIdx: index("channels_type_idx").on(table.channelType),
  })
);

/** Channel row — explicit interface so consumers don't need drizzle-orm to resolve it. */
export interface Channel {
  id: string;
  userId: string;
  workspaceId: string | null;
  title: string | null;
  channelType: ChannelType;
  scope: ChannelScope;
  feedScope: FeedScope | null;
  contextObjectType: string | null;
  contextObjectId: string | null;
  parentChannelId: string | null;
  branchedFromMessageId: string | null;
  branchPurpose: string | null;
  agentId: string;
  status: ChannelStatus;
  agentType: string;
  agentConfig: unknown;
  mcpServerIds: string[] | null;
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
export type NewChannel = Partial<
  Omit<Channel, "id" | "createdAt" | "updatedAt">
> & {
  userId: string;
};

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertChannelSchema = createInsertSchema(channels);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectChannelSchema = createSelectSchema(channels);
