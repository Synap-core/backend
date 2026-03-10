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
export var ChatThreadType;
(function (ChatThreadType) {
  ChatThreadType["MAIN"] = "main";
  ChatThreadType["BRANCH"] = "branch";
})(ChatThreadType || (ChatThreadType = {}));
/**
 * Chat Thread Status
 */
export var ChatThreadStatus;
(function (ChatThreadStatus) {
  ChatThreadStatus["ACTIVE"] = "active";
  ChatThreadStatus["MERGED"] = "merged";
  ChatThreadStatus["ARCHIVED"] = "archived";
})(ChatThreadStatus || (ChatThreadStatus = {}));
/**
 * Chat Thread Agent Types
 */
export var ChatThreadAgentType;
(function (ChatThreadAgentType) {
  ChatThreadAgentType["DEFAULT"] = "default";
  ChatThreadAgentType["META"] = "meta";
  ChatThreadAgentType["PROMPTING"] = "prompting";
  ChatThreadAgentType["KNOWLEDGE_SEARCH"] = "knowledge-search";
  ChatThreadAgentType["CODE"] = "code";
  ChatThreadAgentType["WRITING"] = "writing";
  ChatThreadAgentType["ACTION"] = "action";
})(ChatThreadAgentType || (ChatThreadAgentType = {}));
export const chatThreads = pgTable(
  "chat_threads",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    /** Workspace scope for listing/filtering; null = legacy (user-scoped only). */
    workspaceId: uuid("workspace_id"),
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
    workspaceIdIdx: index("chat_threads_workspace_id_idx").on(
      table.workspaceId
    ),
    parentThreadIdx: index("chat_threads_parent_thread_id_idx").on(
      table.parentThreadId
    ),
    statusIdx: index("chat_threads_status_idx").on(table.status),
  })
);
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertChatThreadSchema = createInsertSchema(chatThreads);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectChatThreadSchema = createSelectSchema(chatThreads);
//# sourceMappingURL=chat-threads.js.map
