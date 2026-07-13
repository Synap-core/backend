/**
 * Per-user presentation and explicit-open state for user-facing resources.
 */

import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type UserResourceType = "entity" | "view" | "inbox_item";
export type ResourceSemanticSize = "small" | "medium" | "large";

export const userResourceState = pgTable(
  "user_entity_state",
  {
    userId: text("user_id").notNull(),
    resourceId: uuid("item_id").notNull(),
    resourceType: varchar("item_type", { length: 20 })
      .$type<UserResourceType>()
      .notNull(),
    starred: boolean("starred").default(false).notNull(),
    pinned: boolean("pinned").default(false).notNull(),
    semanticSize: varchar("semantic_size", {
      length: 20,
    }).$type<ResourceSemanticSize>(),
    lastOpenedAt: timestamp("last_viewed_at", {
      mode: "date",
      withTimezone: true,
    }),
    openCount: integer("view_count").default(0).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.userId, table.resourceId, table.resourceType],
    }),
    starredIdx: index("idx_user_state_starred").on(table.userId, table.starred),
    pinnedIdx: index("idx_user_state_pinned").on(table.userId, table.pinned),
    openedIdx: index("idx_user_state_viewed").on(
      table.userId,
      table.lastOpenedAt
    ),
  })
);

export type UserResourceState = typeof userResourceState.$inferSelect;
export type NewUserResourceState = typeof userResourceState.$inferInsert;
