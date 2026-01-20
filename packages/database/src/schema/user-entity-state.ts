/**
 * User Entity State Schema - User interaction tracking
 *
 * Tracks user-specific state for both entities and inbox_items:
 * - Starred (important)
 * - Pinned (keep at top)
 * - Last viewed
 * - View count
 */

import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  boolean,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

export const userEntityState = pgTable(
  "user_entity_state",
  {
    // Composite key
    userId: text("user_id").notNull(),
    itemId: uuid("item_id").notNull(),
    itemType: varchar("item_type", { length: 20 }).notNull(), // 'entity' | 'inbox_item'

    // Interaction flags
    starred: boolean("starred").default(false),
    pinned: boolean("pinned").default(false),

    // Analytics
    lastViewedAt: timestamp("last_viewed_at", {
      mode: "date",
      withTimezone: true,
    }),
    viewCount: integer("view_count").default(0),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.itemId, table.itemType] }),
    starredIdx: index("idx_user_state_starred").on(table.userId, table.starred),
    pinnedIdx: index("idx_user_state_pinned").on(table.userId, table.pinned),
    viewedIdx: index("idx_user_state_viewed").on(
      table.userId,
      table.lastViewedAt
    ),
  })
);

export type UserEntityState = typeof userEntityState.$inferSelect;
export type NewUserEntityState = typeof userEntityState.$inferInsert;
