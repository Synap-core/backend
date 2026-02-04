/**
 * Chat Threads Schema
 *
 * Metadata for conversation threads (main chats and branches).
 * Messages are stored in conversation_messages table.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Chat Thread Types
 */
export enum ChatThreadType {
  MAIN = "main",
  BRANCH = "branch",
}

/**
 * Chat Thread Status
 */
export enum ChatThreadStatus {
  ACTIVE = "active",
  MERGED = "merged",
  ARCHIVED = "archived",
}

/**
 * Chat Thread Agent Types
 */
export enum ChatThreadAgentType {
  DEFAULT = "default",
  META = "meta",
  PROMPTING = "prompting",
  KNOWLEDGE_SEARCH = "knowledge-search",
  CODE = "code",
  WRITING = "writing",
  ACTION = "action",
}

export const chatThreads = pgTable(
  "chat_threads",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    projectIds: uuid("project_ids").array(), // Optional: threads can be scoped to projects

    // Thread metadata
    title: text("title"),
    threadType: text("thread_type", {
      enum: [ChatThreadType.MAIN, ChatThreadType.BRANCH],
    })
      .notNull()
      .default(ChatThreadType.MAIN),

    // Branching
    parentThreadId: uuid("parent_thread_id"), // Self-reference
    branchedFromMessageId: uuid("branched_from_message_id"), // Reference to conversation_messages
    branchPurpose: text("branch_purpose"), // "Research competitors for SaaS"

    // Agent assignment
    agentId: text("agent_id").notNull().default("orchestrator"),

    // Status
    status: text("status", {
      enum: [
        ChatThreadStatus.ACTIVE,
        ChatThreadStatus.MERGED,
        ChatThreadStatus.ARCHIVED,
      ],
    })
      .notNull()
      .default(ChatThreadStatus.ACTIVE),

    // Agent type for multi-agent system
    agentType: text("agent_type", {
      enum: [
        ChatThreadAgentType.DEFAULT,
        ChatThreadAgentType.META,
        ChatThreadAgentType.PROMPTING,
        ChatThreadAgentType.KNOWLEDGE_SEARCH,
        ChatThreadAgentType.CODE,
        ChatThreadAgentType.WRITING,
        ChatThreadAgentType.ACTION,
      ],
    })
      .notNull()
      .default(ChatThreadAgentType.DEFAULT),
    agentConfig: jsonb("agent_config"), // Custom agent configuration (system prompt, tools, etc.)

    // Context (compressed summaries from merged branches)
    contextSummary: text("context_summary"),

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
    userIdIdx: index("chat_threads_user_id_idx").on(table.userId),
    parentThreadIdx: index("chat_threads_parent_thread_id_idx").on(
      table.parentThreadId
    ),
    projectIdsIdx: index("chat_threads_project_ids_idx").on(table.projectIds),
    statusIdx: index("chat_threads_status_idx").on(table.status),
  })
);

export type ChatThread = typeof chatThreads.$inferSelect;
export type NewChatThread = typeof chatThreads.$inferInsert;

import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertChatThreadSchema = createInsertSchema(chatThreads);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectChatThreadSchema = createSelectSchema(chatThreads);
