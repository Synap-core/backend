/**
 * Entities Schema - The Knowledge Graph Nodes
 *
 * This is a projection (materialized view) of the event stream.
 *
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import {
  pgTable,
  uuid,
  timestamp,
  text,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { documents } from "./documents.js";
import { profiles } from "./profiles.js";

// EntityType enum removed - use profile slugs (strings) instead

export const entities = pgTable("entities", {
  // Primary key
  id: uuid("id").defaultRandom().primaryKey(),

  // Context
  userId: text("user_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(), // Every entity belongs to a workspace
  // Projects: Use relations table with type "belongs_to_project"

  // Profile reference (NEW - for dynamic types)
  profileId: uuid("profile_id").references(() => profiles.id, {
    onDelete: "set null",
  }),

  // Entity type: 'note', 'task', 'project', etc. (DEPRECATED - use profile.slug)
  // Kept for backward compatibility, will be populated from profile.slug
  type: text("type").notNull(), // No enum constraint - now flexible

  // Display metadata (NOT the full content!)
  title: text("title"),
  preview: text("preview"),

  // Document reference (for entities with content)
  // References documents table for full content storage
  documentId: uuid("document_id").references(() => documents.id, {
    onDelete: "set null",
  }),

  // Properties (JSONB) - Source of truth for entity metadata
  // Validated against profile property definitions
  properties: jsonb("properties").default("{}").notNull(),

  // Optimistic locking
  version: integer("version").default(1).notNull(),

  // Timestamps
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
});

// Generate Zod schemas (Single Source of Truth)
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertEntitySchema = createInsertSchema(entities);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectEntitySchema = createSelectSchema(entities);
