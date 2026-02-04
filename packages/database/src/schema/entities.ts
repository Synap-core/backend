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

/**
 * Entity Types
 *
 * Standard entity types in the system.
 * Users can create custom types via user preferences.
 */
export enum EntityType {
  NOTE = "note",
  TASK = "task",
  PROJECT = "project",
  DOCUMENT = "document",
  PAGE = "page",
  HABIT = "habit",
  EVENT = "event",
  PERSON = "person",
  FILE = "file",
}

export const entities = pgTable("entities", {
  // Primary key
  id: uuid("id").defaultRandom().primaryKey(),

  // Context
  userId: text("user_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(), // Every entity belongs to a workspace
  projectIds: uuid("project_ids").array(), // Optional: entities can be in multiple projects

  // Entity type: 'note', 'task', 'project', 'page', 'habit', 'event', 'person', 'file'
  type: text("type", {
    enum: [
      EntityType.NOTE,
      EntityType.TASK,
      EntityType.PROJECT,
      EntityType.DOCUMENT,
      EntityType.PAGE,
      EntityType.HABIT,
      EntityType.EVENT,
      EntityType.PERSON,
      EntityType.FILE,
    ],
  }).notNull(),

  // Display metadata (NOT the full content!)
  title: text("title"),
  preview: text("preview"),

  // Document reference (for entities with content)
  // References documents table for full content storage
  documentId: uuid("document_id").references(() => documents.id, {
    onDelete: "set null",
  }),

  // Type-specific metadata (JSONB)
  // Stores entity type-specific fields (task status, person email, etc.)
  metadata: jsonb("metadata").default("{}"),

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
