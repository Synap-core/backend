/**
 * Projects Schema
 *
 * User projects for organizing threads and entities.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const projects = pgTable(
  "projects",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Context
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(), // Every project belongs to a workspace

    // Project info
    name: text("name").notNull(),
    description: text("description"),

    // Status
    status: text("status", {
      enum: ["active", "archived", "completed"],
    })
      .notNull()
      .default("active"),

    // Settings (agent preferences, defaults, etc.)
    settings: jsonb("settings"),
    metadata: jsonb("metadata"),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    userIdIdx: index("projects_user_id_idx").on(table.userId),
    statusIdx: index("projects_status_idx").on(table.status),
  })
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
