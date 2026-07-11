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
import { isNotNull } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { channels } from "./channels.js";
import { inboxItems } from "./inbox-items.js";
import { sessions } from "./sessions.js";

/**
 * Message Roles
 *
 * Semantic role of the message author in the conversation.
 */
export const MessageRole = {
  USER: "user",
  ASSISTANT: "assistant",
  SYSTEM: "system",
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

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
export const MessageAuthorType = {
  HUMAN: "human",
  AI_AGENT: "ai_agent",
  EXTERNAL: "external", // message imported from external platform
  BOT: "bot", // automated system/notification message
} as const;
export type MessageAuthorType =
  (typeof MessageAuthorType)[keyof typeof MessageAuthorType];

/**
 * Message Categories
 *
 * What kind of interaction this message represents.
 */
export const MessageCategory = {
  CHAT: "chat", // standard conversational message
  COMMENT: "comment", // comment on an entity/document/view
  SYSTEM_NOTIFICATION: "system_notification", // cross-channel update, conflict alerts, etc.
  REVIEW: "review", // part of a document review flow
} as const;
export type MessageCategory =
  (typeof MessageCategory)[keyof typeof MessageCategory];

/**
 * Routed Attribution Source — how an AI teammate came to author a message in a
 * multiplayer room. Lets the UI show "orchestrator routed to X" vs a direct
 * @mention vs a plain reply.
 *
 * orchestrator — the routing engine selected this teammate (auto-routed).
 * mention      — a human @mentioned this teammate explicitly.
 * direct       — the teammate replied in its own bound channel (no routing).
 *
 * Free at the DB level; the later routing pass sets it. Null = pre-routing /
 * non-routed message (back-compat).
 */
export const RoutedSource = {
  ORCHESTRATOR: "orchestrator",
  MENTION: "mention",
  DIRECT: "direct",
} as const;
export type RoutedSource = (typeof RoutedSource)[keyof typeof RoutedSource];

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

    /**
     * Routed-attribution: when an AI teammate authored this message because the
     * orchestrator routed to it (or it was @mentioned), this FK records WHICH
     * teammate (agent-user id) so the UI can render "orchestrator routed to X".
     * Real FK column (not buried in JSONB) — mirrors the 0038/0039 pattern of
     * promoting queryable identity out of the blob, and keeps it JOIN-able +
     * referential-integrity-safe. Null = not a routed message.
     */
    routedTeammateId: text("routed_teammate_id"),

    /** How this teammate came to author the message — see RoutedSource. */
    routedSource: text("routed_source", {
      enum: [
        RoutedSource.ORCHESTRATOR,
        RoutedSource.MENTION,
        RoutedSource.DIRECT,
      ],
    }),

    // Ownership
    userId: text("user_id").notNull(),

    // Timestamps
    timestamp: timestamp("timestamp", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),

    // Hash chain (blockchain-like integrity)
    previousHash: text("previous_hash"), // Hash of parent message
    hash: text("hash").notNull(), // SHA256 of this message

    // Session linkage — which session this message was sent in
    // Null for messages sent before session-scoped memory was introduced
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),

    // Soft delete
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),

    // Edit marker — set when a user edits their own message content
    editedAt: timestamp("edited_at", { mode: "date", withTimezone: true }),

    // Ephemeral marker — when true, the message is delivered live over the
    // realtime socket (so the requester sees it in-session) but is EXCLUDED from
    // all channel history/list reads, so it disappears on reload. Powers the
    // "catch me up" recap flow: visible live, gone on refresh.
    ephemeral: boolean("ephemeral").notNull().default(false),
  },
  (table) => ({
    channelIdIdx: index("messages_channel_id_idx").on(table.channelId),
    inboxItemIdx: index("messages_inbox_item_idx").on(table.inboxItemId),
    externalSourceIdx: index("messages_ext_source_idx").on(
      table.externalSource
    ),
    sessionIdIdx: index("messages_session_id_idx").on(table.sessionId),
    channelTimestampIdx: index("messages_channel_timestamp_idx").on(
      table.channelId,
      table.timestamp
    ),
    routedTeammateIdx: index("messages_routed_teammate_idx")
      .on(table.routedTeammateId)
      .where(isNotNull(table.routedTeammateId)),
  })
);

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
}
export type NewMessageRow = Partial<
  Omit<MessageRow, "id" | "timestamp" | "hash">
> & {
  channelId: string;
  content: string;
  userId: string;
  role: MessageRole;
};
