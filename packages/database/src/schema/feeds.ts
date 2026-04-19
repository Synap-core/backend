/**
 * Feeds Schema
 *
 * A feed is a long-running AI researcher bound to one or more external source
 * configs. It watches those sources on a schedule, AI-classifies each item
 * against `criteria`, and posts matches into its FEED-type channel. Users
 * browse, promote items to entities (via `capture` profile), or dismiss.
 *
 * feedType groups:
 *   Person    : leads | hiring | investors   (who to meet / hire / raise from)
 *   Ecosystem : trends | competitors | press (what's happening around you)
 *
 * One feed maps 1:1 to a channel (channelId). Items are messages in that
 * channel. Sources bind via `source_subscriptions` (owned by Agent 1's
 * source-configs work — feedId is referenced there).
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from "drizzle-orm/pg-core";

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
export type FeedStatusValue = (typeof FEED_STATUSES)[number];

export const feeds = pgTable(
  "feeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),
    /** null = pod-wide (visible in all workspaces for this user). */
    workspaceId: uuid("workspace_id"),

    name: text("name").notNull(),
    feedType: text("feed_type").notNull(),
    criteria: text("criteria").notNull(),

    /** FK to channels.id — the FEED-type channel that hosts items. */
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
  (t) => ({
    userIdx: index("idx_feeds_user").on(t.userId),
    statusIdx: index("idx_feeds_status").on(t.status),
    nextRunIdx: index("idx_feeds_next_run").on(t.nextRunAt),
    channelIdx: index("idx_feeds_channel").on(t.channelId),
  })
);

export type Feed = typeof feeds.$inferSelect;
export type NewFeed = typeof feeds.$inferInsert;
