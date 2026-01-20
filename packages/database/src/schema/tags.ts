/**
 * Tags Schema - For organizing entities
 *
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const tags = pgTable("tags", {
  // Primary key
  id: uuid("id").defaultRandom().primaryKey(),

  // Context (workspace & project organization)
  userId: text("user_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(), // Every tag belongs to a workspace
  projectIds: uuid("project_ids").array(), // Optional: tags can be scoped to projects

  // Tag name (unique per user)
  name: text("name").notNull(),

  // Display color
  color: text("color"),

  // Timestamps
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertTagSchema = createInsertSchema(tags);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectTagSchema = createSelectSchema(tags);

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
