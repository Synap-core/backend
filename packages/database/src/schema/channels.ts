/**
 * Channels Schema
 *
 * A channel is the universal container for conversations in Synap.
 * It replaces the old `chat_threads` table and introduces a richer
 * `channel_type` that makes AI threads, comment threads, document review
 * threads, external-platform imports, and DMs first-class concepts.
 *
 * Messages are stored in the `messages` table (was conversation_messages).
 * Context objects (entities, documents, views) are tracked in `channel_context_items`.
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
 * Channel Types
 *
 * AI_THREAD       — AI conversation (was 'main')
 * BRANCH          — sub-conversation branched from a parent channel message
 * ENTITY_COMMENTS — comment/discussion thread attached to a specific entity
 * DOCUMENT_REVIEW — review/comment thread attached to a specific document
 * VIEW_DISCUSSION — discussion thread attached to a view
 * DIRECT          — direct message between two users
 * EXTERNAL_IMPORT — imported conversation from an external platform (WhatsApp, Slack, Gmail, etc.)
 * A2AI            — agent-to-agent async communication channel; no human required as author
 */
export enum ChannelType {
  AI_THREAD = "ai_thread",
  BRANCH = "branch",
  ENTITY_COMMENTS = "entity_comments",
  DOCUMENT_REVIEW = "document_review",
  VIEW_DISCUSSION = "view_discussion",
  DIRECT = "direct",
  EXTERNAL_IMPORT = "external_import",
  A2AI = "a2ai",
}

/**
 * Channel Status
 */
export enum ChannelStatus {
  ACTIVE = "active",
  MERGED = "merged",
  ARCHIVED = "archived",
}

/**
 * Channel Agent Types
 *
 * Determines which AI agent handles messages in this channel.
 */
export enum ChannelAgentType {
  DEFAULT = "default",
  META = "meta",
  PROMPTING = "prompting",
  KNOWLEDGE_SEARCH = "knowledge-search",
  CODE = "code",
  WRITING = "writing",
  ACTION = "action",
  ONBOARDING = "onboarding",
  WORKSPACE_CREATION = "workspace-creation",
}

export const channels = pgTable(
  "channels",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Workspace scope for listing/filtering; null = legacy (user-scoped only). */
    workspaceId: uuid("workspace_id"),

    // Channel metadata
    title: text("title"),
    channelType: text("channel_type", {
      enum: [
        ChannelType.AI_THREAD,
        ChannelType.BRANCH,
        ChannelType.ENTITY_COMMENTS,
        ChannelType.DOCUMENT_REVIEW,
        ChannelType.VIEW_DISCUSSION,
        ChannelType.DIRECT,
        ChannelType.EXTERNAL_IMPORT,
        ChannelType.A2AI,
      ],
    })
      .notNull()
      .default(ChannelType.AI_THREAD),

    // Context: what object this channel is "about"
    // Set for ENTITY_COMMENTS, DOCUMENT_REVIEW, VIEW_DISCUSSION channels.
    contextObjectType: text("context_object_type"), // 'entity' | 'document' | 'view'
    contextObjectId: uuid("context_object_id"),

    // Branching (for BRANCH channels)
    parentChannelId: uuid("parent_channel_id"), // Self-reference to channels.id
    branchedFromMessageId: uuid("branched_from_message_id"), // Reference to messages.id
    branchPurpose: text("branch_purpose"), // "Research competitors for SaaS"

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

    // Agent type for multi-agent system
    agentType: text("agent_type", {
      enum: [
        ChannelAgentType.DEFAULT,
        ChannelAgentType.META,
        ChannelAgentType.PROMPTING,
        ChannelAgentType.KNOWLEDGE_SEARCH,
        ChannelAgentType.CODE,
        ChannelAgentType.WRITING,
        ChannelAgentType.ACTION,
        ChannelAgentType.ONBOARDING,
        ChannelAgentType.WORKSPACE_CREATION,
      ],
    })
      .notNull()
      .default(ChannelAgentType.DEFAULT),

    agentConfig: jsonb("agent_config"), // Custom agent configuration (system prompt, tools, etc.)

    // Context (compressed summaries from merged branches)
    contextSummary: text("context_summary"),

    // External source (for EXTERNAL_IMPORT channels)
    externalSource: text("external_source"), // 'whatsapp' | 'slack' | 'gmail' | 'sms'
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
  })
);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertChannelSchema = createInsertSchema(channels);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectChannelSchema = createSelectSchema(channels);
