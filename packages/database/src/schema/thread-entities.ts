/**
 * Thread Entities Schema
 *
 * Tracks which entities are used/updated/referenced by chat threads.
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
import { entities } from "./entities.js";
import { conversationMessages } from "./conversation-messages.js";
import { events } from "./events.js";

export const threadEntities = pgTable(
  "thread_entities",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Thread reference
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),

    // Entity reference
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),

    // Relationship type
    relationshipType: text("relationship_type", {
      enum: [
        "used_as_context", // Entity used as context (read-only)
        "created", // Entity created in this thread
        "updated", // Entity updated in this thread
        "referenced", // Entity referenced/mentioned
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
    threadIdIdx: index("thread_entities_thread_id_idx").on(table.threadId),
    entityIdIdx: index("thread_entities_entity_id_idx").on(table.entityId),

    // User/workspace filtering (RLS)
    userIdIdx: index("thread_entities_user_id_idx").on(table.userId),
    workspaceIdIdx: index("thread_entities_workspace_id_idx").on(
      table.workspaceId
    ),

    // Conflict queries
    conflictIdx: index("thread_entities_conflict_idx").on(table.conflictStatus),

    // Prevent duplicate relationships (same thread + entity + type)
    uniqueRelationship: unique("thread_entities_unique").on(
      table.threadId,
      table.entityId,
      table.relationshipType
    ),
  })
);

export type ThreadEntity = typeof threadEntities.$inferSelect;
export type NewThreadEntity = typeof threadEntities.$inferInsert;

// Generate Zod schemas (Single Source of Truth)
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertThreadEntitySchema = createInsertSchema(threadEntities);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectThreadEntitySchema = createSelectSchema(threadEntities);
