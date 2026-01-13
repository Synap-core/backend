/**
 * Roles Schema - Custom role permissions (RBAC + ABAC)
 */

import { pgTable, uuid, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, {
    onDelete: "cascade",
  }),

  // JSONB permissions object
  permissions: jsonb("permissions").notNull().default("{}"),

  // ABAC filters (optional)
  filters: jsonb("filters").default("{}"),

  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;

import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertRoleSchema = createInsertSchema(roles);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectRoleSchema = createSelectSchema(roles);
