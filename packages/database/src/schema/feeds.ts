/**
 * Feeds table — long-running AI researcher rows bound 1:1 to FEED-type channels.
 *
 * Migration: 0007_feeds.sql
 *
 * DEPRECATED — entity-extract-worker.ts has been migrated to resolve feed config
 * from source_subscriptions + source_configs. This table is retained for backward
 * compatibility: if a subscription's feedId maps to a legacy feeds.id, the scheduler
 * will degrade gracefully. Full removal will happen in Phase 3 after migration is
 * verified across all pods.
 *
 * Do NOT remove without confirming all subscriptions use the new path.
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
