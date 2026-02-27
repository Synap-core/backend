/**
 * Messages Schema
 *
 * Stores all messages in Synap's unified messaging layer.
 * Replaces `conversation_messages` with additional classification fields:
 *
 * - `authorType`       — who produced the message (human, AI agent, external, bot)
 * - `messageCategory`  — what kind of message it is (chat, comment, review, notification)
 * - `externalSource`   — which external platform it came from (whatsapp, slack, gmail, etc.)
 * - `inboxItemId`      — links back to the inbox_items row it was imported from
 *
 * Hash chain (previousHash + hash) preserved for message integrity.
 *
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import type { ConversationMessageMetadata } from "@synap-core/core";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { channels } from "./channels.js";
import { inboxItems } from "./inbox-items.js";

/**
 * Message Roles
 *
 * Semantic role of the message author in the conversation.
 */
export enum MessageRole {
  USER = "user",
  ASSISTANT = "assistant",
  SYSTEM = "system",
}

/**
 * Message Author Types
 *
 * Who actually produced this message.
 * Combined with `role` for full provenance:
 *   role=user  + authorType=human    → a workspace user typed this
 *   role=user  + authorType=external → WhatsApp/Slack contact sent this
 *   role=assistant + authorType=ai_agent → AI agent responded
 *   role=system    + authorType=bot  → automated system message
 */
export enum MessageAuthorType {
  HUMAN = "human",
  AI_AGENT = "ai_agent",
  EXTERNAL = "external", // message imported from external platform
  BOT = "bot", // automated system/notification message
}

/**
 * Message Categories
 *
 * What kind of interaction this message represents.
 */
export enum MessageCategory {
  CHAT = "chat", // standard conversational message
  COMMENT = "comment", // comment on an entity/document/view
  SYSTEM_NOTIFICATION = "system_notification", // cross-channel update, conflict alerts, etc.
  REVIEW = "review", // part of a document review flow
}

export const messages = pgTable(
  "messages",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Channel management
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"), // Parent message (for message-level branching)

    // Message classification
    role: text("role", {
      enum: [MessageRole.USER, MessageRole.ASSISTANT, MessageRole.SYSTEM],
    }).notNull(),

    authorType: text("author_type", {
      enum: [
        MessageAuthorType.HUMAN,
        MessageAuthorType.AI_AGENT,
        MessageAuthorType.EXTERNAL,
        MessageAuthorType.BOT,
      ],
    })
      .notNull()
      .default(MessageAuthorType.HUMAN),

    messageCategory: text("message_category", {
      enum: [
        MessageCategory.CHAT,
        MessageCategory.COMMENT,
        MessageCategory.SYSTEM_NOTIFICATION,
        MessageCategory.REVIEW,
      ],
    })
      .notNull()
      .default(MessageCategory.CHAT),

    // External source (set when authorType = 'external')
    externalSource: text("external_source"), // 'whatsapp' | 'slack' | 'gmail' | 'sms' | null

    // Link to inbox item this message was imported from (if any)
    inboxItemId: uuid("inbox_item_id").references(() => inboxItems.id, {
      onDelete: "set null",
    }),

    // Message content
    content: text("content").notNull(),

    // Metadata (AI suggestions, sources, tool results, etc.)
    metadata: jsonb("metadata").$type<ConversationMessageMetadata | null>(),

    // Ownership
    userId: text("user_id").notNull(),

    // Timestamps
    timestamp: timestamp("timestamp", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),

    // Hash chain (blockchain-like integrity)
    previousHash: text("previous_hash"), // Hash of parent message
    hash: text("hash").notNull(), // SHA256 of this message

    // Soft delete
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => ({
    channelIdIdx: index("messages_channel_id_idx").on(table.channelId),
    inboxItemIdx: index("messages_inbox_item_idx").on(table.inboxItemId),
    externalSourceIdx: index("messages_ext_source_idx").on(
      table.externalSource
    ),
  })
);

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
