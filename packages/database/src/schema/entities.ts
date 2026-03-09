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
  index,
} from "drizzle-orm/pg-core";
import { documents } from "./documents.js";
import { profiles } from "./profiles.js";

// EntityType enum removed - use profile slugs (strings) instead

export const entities = pgTable(
  "entities",
  {
    // Primary key
    id: uuid("id").defaultRandom().primaryKey(),

    // Context
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id"), // Nullable — null means global (visible across all workspaces)
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

    // System data (JSONB) - System-managed state, separate from user properties
    // Stores: viewMode ('document' | 'bento'), bentoViewId (uuid of entity bento view)
    // Never shown in property editors; not validated against profile schema.
    systemData: jsonb("system_data").default("{}").notNull(),

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
  },
  (table) => ({
    workspaceIdIdx: index("entities_workspace_id_idx").on(table.workspaceId),
    userIdIdx: index("entities_user_id_idx").on(table.userId),
    workspaceUserDeletedIdx: index("entities_workspace_user_deleted_idx").on(
      table.workspaceId,
      table.userId,
      table.deletedAt
    ),
    profileIdIdx: index("entities_profile_id_idx").on(table.profileId),
    typeWorkspaceIdx: index("entities_type_workspace_idx").on(
      table.type,
      table.workspaceId
    ),
  })
);

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
