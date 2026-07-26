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
import type { ProvenanceKind } from "./provenance.js";

// EntityType enum removed - use profile slugs (strings) instead

/**
 * System-data flag for template example rows that exist only to demonstrate a
 * workspace shape. Unlike `createdByKind`, this does not exclude real imports,
 * extraction results, or automations that legitimately run as the system.
 */
export const ONBOARDING_SCAFFOLD_SYSTEM_DATA_KEY = "onboardingScaffold";
export const ONBOARDING_SCAFFOLD_SYSTEM_DATA = {
  [ONBOARDING_SCAFFOLD_SYSTEM_DATA_KEY]: true,
} as const;

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

    // Provenance (Wave B3) — who/what authored this row. Nullable; legacy rows =
    // NULL (treated as human/owner). FKs + indexes are added in migration 0107
    // (kept off the Drizzle column defs to avoid schema import cycles, matching
    // the existing plain-text user_id pattern).
    createdByKind: text("created_by_kind").$type<ProvenanceKind>(),
    createdByUserId: text("created_by_user_id"),
    agentUserId: text("agent_user_id"),
    sourceProposalId: uuid("source_proposal_id"),
    correlationId: uuid("correlation_id"),

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
