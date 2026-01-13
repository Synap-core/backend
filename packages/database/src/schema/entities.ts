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

export const entities = pgTable("entities", {
  // Primary key
  id: uuid("id").defaultRandom().primaryKey(),

  // Which user owns this entity?
  userId: text("user_id").notNull(),

  // Workspace (for team entities, NULL for personal)
  workspaceId: uuid("workspace_id"),

  // Entity type: 'note', 'task', 'project', 'page', 'habit', 'event', 'person', 'file'
  type: text("type").notNull(),

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

  // File storage references (R2/S3/Local) - DEPRECATED, use documents table
  // TODO: Remove these columns after migration
  fileUrl: text("file_url"), // Public URL: https://r2.../users/123/notes/456.md
  filePath: text("file_path"), // Storage key: users/123/notes/456.md
  fileSize: integer("file_size"), // Size in bytes
  fileType: text("file_type"), // 'markdown', 'pdf', 'audio', 'video', 'image'
  checksum: text("checksum"), // SHA256 hash for integrity verification

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
