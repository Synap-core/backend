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

export const chatThreads = pgTable(
  "chat_threads",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    projectId: uuid("project_id"),

    // Thread metadata
    title: text("title"),
    threadType: text("thread_type", {
      enum: ["main", "branch"],
    })
      .notNull()
      .default("main"),

    // Branching
    parentThreadId: uuid("parent_thread_id"), // Self-reference
    branchedFromMessageId: uuid("branched_from_message_id"), // Reference to conversation_messages
    branchPurpose: text("branch_purpose"), // "Research competitors for SaaS"

    // Agent assignment
    agentId: text("agent_id").notNull().default("orchestrator"),

    // Status
    status: text("status", {
      enum: ["active", "merged", "archived"],
    })
      .notNull()
      .default("active"),

    // Agent type for multi-agent system
    agentType: text("agent_type", {
      enum: [
        "default",
        "meta",
        "prompting",
        "knowledge-search",
        "code",
        "writing",
        "action",
      ],
    })
      .notNull()
      .default("default"), // Changed from 'meta' to 'default'
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
    projectIdIdx: index("chat_threads_project_id_idx").on(table.projectId),
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
