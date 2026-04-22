/**
 * Signal Feed Database Schema
 *
 * Tables for signal subscriptions, classifications, fetch history, and auto-links.
 * Enables external content (RSS feeds, social media) to become first-class entities.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { eq, gt } from "drizzle-orm";
import { users, workspaces, entities } from "./index.js";

/**
 * signal_subscriptions - User's explicit signal preferences
 */
export const signalSubscriptions = pgTable(
  "signal_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    topic: text("topic").notNull(),
    sourcePlatform: text("source_platform"),
    sourceRoute: text("source_route"),

    isActive: boolean("is_active").notNull().default(true),
    confidence: numeric("confidence", { precision: 3, scale: 2 })
      .notNull()
      .default("0.50"),
    notificationPreference: text("notification_preference")
      .notNull()
      .default("none"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      columns: [
        table.userId,
        table.workspaceId,
        table.topic,
        table.sourcePlatform,
        table.sourceRoute,
      ],
    }),
    index("signal_subscriptions_user_workspace_idx")
      .on(table.userId, table.workspaceId)
      .where(eq(table.isActive, true)),
    index("signal_subscriptions_topic_idx")
      .on(table.topic)
      .where(eq(table.isActive, true)),
  ]
);

/**
 * signal_classifications - AI-classified user interests
 */
export const signalClassifications = pgTable(
  "signal_classifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    topic: text("topic").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 })
      .notNull()
      .default("0.00"),

    sourceType: text("source_type").notNull(),
    sourceEntityId: uuid("source_entity_id"),
    sourceSignalId: uuid("source_signal_id").references(() => entities.id, {
      onDelete: "set null",
    }),

    occurrenceCount: integer("occurrence_count").notNull().default(1),
    totalWeight: numeric("total_weight", { precision: 6, scale: 3 })
      .notNull()
      .default("1.000"),

    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    decayRate: numeric("decay_rate", { precision: 3, scale: 2 })
      .notNull()
      .default("0.95"),
    lastDecayAt: timestamp("last_decay_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.workspaceId, table.topic] }),
    index("signal_classifications_confidence_idx")
      .on(table.confidence.desc())
      .where(gt(table.confidence, 0.1)),
    index("signal_classifications_recency_idx").on(table.lastSeenAt.desc()),
  ]
);

/**
 * signal_fetch_history - History of signal fetches
 */
export const signalFetchHistory = pgTable(
  "signal_fetch_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    sourceRoute: text("source_route").notNull(),
    sourcePlatform: text("source_platform").notNull(),
    fetchType: text("fetch_type").notNull(),

    itemCount: integer("item_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    cacheHit: boolean("cache_hit").notNull().default(false),

    durationMs: integer("duration_ms").notNull(),
    responseSizeBytes: integer("response_size_bytes"),

    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    userAgent: text("user_agent"),
    clientIp: text("client_ip"),
  },
  (table) => [
    index("signal_fetch_history_user_time_idx").on(
      table.userId,
      table.fetchedAt.desc()
    ),
    index("signal_fetch_history_platform_idx").on(
      table.sourcePlatform,
      table.fetchedAt.desc()
    ),
  ]
);

/**
 * signal_auto_links - Auto-linking between signals and entities
 */
export const signalAutoLinks = pgTable(
  "signal_auto_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    signalEntityId: uuid("signal_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    linkedEntityId: uuid("linked_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),

    linkType: text("link_type").notNull(),
    linkStrength: numeric("link_strength", { precision: 3, scale: 2 })
      .notNull()
      .default("0.50"),
    linkContext: text("link_context"),

    source: text("source").notNull(),
    sourceModel: text("source_model"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({
      columns: [table.signalEntityId, table.linkedEntityId, table.linkType],
    }),
    index("signal_auto_links_signal_idx").on(table.signalEntityId),
    index("signal_auto_links_linked_idx").on(table.linkedEntityId),
    index("signal_auto_links_strength_idx").on(table.linkStrength.desc()),
  ]
);
