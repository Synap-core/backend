/**
 * Message Links Schema
 *
 * Universal linking system for messages.
 * Allows messages to link to ANY object in the system.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { messages } from "./messages.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const messageLinks = pgTable(
  "message_links",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Message reference
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),

    // Universal link (polymorphic)
    targetType: text("target_type").notNull(), // "entity" | "document" | "proposal" | "message" | "event" | "user" | ...
    targetId: uuid("target_id").notNull(),

    // Relationship type
    relationshipType: text("relationship_type").notNull(), // "created" | "updated" | "references" | "approves" | "rejects" | "comments" | ...

    // Position in message (for inline references)
    position: jsonb("position"), // { start: number, end: number }

    // Metadata
    metadata: jsonb("metadata"), // Additional context

    // Multi-tenant
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Index for querying by message
    messageIdIdx: index("message_links_message_id_idx").on(table.messageId),

    // Index for querying by target (polymorphic)
    targetIdx: index("message_links_target_idx").on(
      table.targetType,
      table.targetId
    ),

    // Index for querying by relationship type
    relationshipIdx: index("message_links_relationship_idx").on(
      table.relationshipType
    ),

    // Index for user/workspace filtering
    userIdIdx: index("message_links_user_id_idx").on(table.userId),
    workspaceIdIdx: index("message_links_workspace_id_idx").on(
      table.workspaceId
    ),
  })
);

// Type exports
export type MessageLink = typeof messageLinks.$inferSelect;
export type NewMessageLink = typeof messageLinks.$inferInsert;

// Zod schemas (for validation)
export const insertMessageLinkSchema = createInsertSchema(messageLinks);
export const selectMessageLinkSchema = createSelectSchema(messageLinks);
