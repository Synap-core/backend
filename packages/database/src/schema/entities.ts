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
import { sql } from "drizzle-orm";
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
    // The space a POD-WIDE row was filed for (0348): its members may read it
    // (`accessScopeWhere`). Set only when `workspaceId` is NULL — a CHECK in
    // the migration makes that a database fact; the FK (ON DELETE SET NULL)
    // lives there too, off the column def like the provenance FKs below.
    homeWorkspaceId: uuid("home_workspace_id"),
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

    // LIFECYCLE (0319, work model W12): the kind's status is THIS column pair —
    // the truth. `properties[<lifecycle slug>]` is its READ PROJECTION, written
    // through only by the `moveStatus` door (`services/lifecycle/move-status.ts`).
    // `statusCategory` is one of the fixed `LIFECYCLE_CATEGORIES`
    // (`utils/lifecycle-model.ts`), CHECKed in the database. NULL = the kind
    // declares no lifecycle (or a stored value no option declares).
    status: text("status"),
    statusCategory: text("status_category"),

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
    // The read floor's home-space branch (0348).
    homeWorkspaceIdx: index("entities_home_workspace_idx")
      .on(table.homeWorkspaceId)
      .where(
        sql`${table.workspaceId} IS NULL AND ${table.homeWorkspaceId} IS NOT NULL`
      ),
    profileStatusCategoryIdx: index("entities_profile_status_category_idx")
      .on(table.profileId, table.statusCategory)
      .where(sql`${table.deletedAt} IS NULL`),
    // The board / lifecycle.list group by status VALUE (0323).
    profileStatusIdx: index("entities_profile_status_idx")
      .on(table.profileId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
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
