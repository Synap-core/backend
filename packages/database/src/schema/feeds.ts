/**
 * Feeds table — long-running AI researcher rows bound 1:1 to FEED-type channels.
 *
 * Migration: 0007_feeds.sql
 * This table is still actively used by entity-extract-worker.ts for feed config
 * resolution. Do NOT remove without updating the worker to use an alternative
 * storage (e.g., entity properties or a channel extension).
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";

export const feeds = pgTable(
  "feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"),
    name: text("name").notNull(),
    feedType: text("feed_type").notNull(),
    criteria: text("criteria").notNull(),
    channelId: uuid("channel_id").notNull(),
    scheduleCron: text("schedule_cron").notNull().default("*/15 * * * *"),
    status: text("status").notNull().default("active"),
    errorMessage: text("error_message"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    itemCount: integer("item_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    userIdIdx: index("idx_feeds_user").on(table.userId),
    statusIdx: index("idx_feeds_status").on(table.status),
    nextRunIdx: index("idx_feeds_next_run").on(table.nextRunAt),
    channelIdx: index("idx_feeds_channel").on(table.channelId),
  })
);

export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;

export const FEED_TYPES = [
  "leads",
  "hiring",
  "investors",
  "trends",
  "competitors",
  "press",
] as const;
export type FeedType = (typeof FEED_TYPES)[number];

export const FEED_STATUSES = ["active", "paused", "error"] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];
