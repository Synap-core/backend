/**
 * Inbox Items Schema - External items to be processed
 *
 * For Life Feed: emails, calendar events, Slack messages
 * Lifecycle: External source → inbox_items → processed → archived or converted to entity
 */

import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const inboxItems = pgTable(
  "inbox_items",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Context
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(), // Every inbox item belongs to a workspace
    projectIds: uuid("project_ids").array(), // Optional: items can be related to projects

    // External source (direct columns for queryability)
    provider: varchar("provider", { length: 50 }).notNull(), // 'gmail', 'google_calendar', 'slack'
    account: varchar("account", { length: 255 }).notNull(), // 'user@gmail.com'
    externalId: varchar("external_id", { length: 500 }).notNull(), // ID in external system
    deepLink: text("deep_link"), // 'googlegmail://message?id=...'

    // Content
    type: varchar("type", { length: 50 }).notNull(), // 'email', 'calendar_event', 'slack_message'
    title: text("title").notNull(),
    preview: text("preview"),
    timestamp: timestamp("timestamp", {
      mode: "date",
      withTimezone: true,
    }).notNull(),

    // State
    status: varchar("status", { length: 20 }).default("unread"), // 'unread' | 'read' | 'archived' | 'snoozed'
    snoozedUntil: timestamp("snoozed_until", {
      mode: "date",
      withTimezone: true,
    }),

    // AI-enhanced
    priority: varchar("priority", { length: 20 }), // 'urgent' | 'high' | 'normal' | 'low'
    tags: text("tags").array(), // ['Action', 'FYI']

    // Provider-specific data
    data: jsonb("data").notNull().default("{}"),

    // Lifecycle
    processedAt: timestamp("processed_at", {
      mode: "date",
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userStatusIdx: index("idx_inbox_user_status").on(
      table.userId,
      table.status
    ),
    providerIdx: index("idx_inbox_provider").on(table.provider),
    timestampIdx: index("idx_inbox_timestamp").on(
      table.userId,
      table.timestamp
    ),
    snoozedIdx: index("idx_inbox_snoozed").on(table.userId, table.snoozedUntil),
    priorityIdx: index("idx_inbox_priority").on(table.userId, table.priority),
    externalUnique: uniqueIndex("idx_inbox_external_unique").on(
      table.userId,
      table.provider,
      table.externalId
    ),
  })
);

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const insertInboxItemSchema = createInsertSchema(inboxItems);
export const selectInboxItemSchema = createSelectSchema(inboxItems);

export type InboxItem = typeof inboxItems.$inferSelect;
export type NewInboxItem = typeof inboxItems.$inferInsert;
