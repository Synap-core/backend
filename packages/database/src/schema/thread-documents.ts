/**
 * Thread Documents Schema
 *
 * Tracks which documents are used/updated/referenced by chat threads.
 * Enables context inheritance in Git-like branching system.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-threads.js";
import { documents } from "./documents.js";
import { conversationMessages } from "./conversation-messages.js";
import { events } from "./events.js";

export const threadDocuments = pgTable(
  "thread_documents",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Thread reference
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),

    // Document reference
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),

    // Relationship type
    relationshipType: text("relationship_type", {
      enum: [
        "used_as_context", // Document used as context (read-only)
        "created", // Document created in this thread
        "updated", // Document updated in this thread
        "referenced", // Document referenced/mentioned
        "inherited_from_parent", // Inherited from parent thread
      ],
    }).notNull(),

    // Conflict tracking (for parallel threads)
    conflictStatus: text("conflict_status", {
      enum: ["none", "pending", "resolved"],
    })
      .notNull()
      .default("none"),

    // Source tracking (for traceability)
    sourceMessageId: uuid("source_message_id").references(
      () => conversationMessages.id,
      { onDelete: "set null" }
    ),
    sourceEventId: uuid("source_event_id").references(() => events.id, {
      onDelete: "set null",
    }),

    // Multi-tenant
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Foreign key indexes
    threadIdIdx: index("thread_documents_thread_id_idx").on(table.threadId),
    documentIdIdx: index("thread_documents_document_id_idx").on(
      table.documentId
    ),

    // User/workspace filtering (RLS)
    userIdIdx: index("thread_documents_user_id_idx").on(table.userId),
    workspaceIdIdx: index("thread_documents_workspace_id_idx").on(
      table.workspaceId
    ),

    // Conflict queries
    conflictIdx: index("thread_documents_conflict_idx").on(
      table.conflictStatus
    ),

    // Prevent duplicate relationships
    uniqueRelationship: unique("thread_documents_unique").on(
      table.threadId,
      table.documentId,
      table.relationshipType
    ),
  })
);

export type ThreadDocument = typeof threadDocuments.$inferSelect;
export type NewThreadDocument = typeof threadDocuments.$inferInsert;

// Generate Zod schemas (Single Source of Truth)
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertThreadDocumentSchema = createInsertSchema(threadDocuments);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectThreadDocumentSchema = createSelectSchema(threadDocuments);
