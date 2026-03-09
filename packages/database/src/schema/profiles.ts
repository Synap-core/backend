/**
 * Profiles Schema (Entity Types)
 *
 * Profiles define entity types as configuration, not code.
 * Supports inheritance via parent_profile_id (e.g., "webinar" extends "event").
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  integer,
  timestamp,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * Profile Scope
 */
export enum ProfileScope {
  SYSTEM = "system", // Available to all users (pod-wide)
  SHARED = "shared", // Explicitly shared with specific workspaces via profile_workspace_access
  WORKSPACE = "workspace", // Owned by a single workspace
  USER = "user", // Personal to user
}

export const profiles = pgTable(
  "profiles",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Profile identity (unique slug)
    slug: text("slug").notNull(),

    // Display
    displayName: text("display_name").notNull(),

    // Type hierarchy (inheritance)
    // Note: Self-reference handled via explicit FK constraint in migration
    parentProfileId: uuid("parent_profile_id"),

    // UI hints (JSONB)
    // Examples:
    // - { icon: "calendar", color: "#3B82F6", description: "Scheduled events" }
    uiHints: jsonb("ui_hints").default("{}").notNull(),

    // Default property values applied when creating a new entity of this type.
    // Example: { status: "open", priority: "medium" }
    defaultValues: jsonb("default_values").default("{}").notNull(),

    // Semantic identity for cross-workspace queries.
    // e.g. "task", "project", "person" — NULL means no cross-workspace semantics.
    semanticSlug: text("semantic_slug"),

    // Scope (who can use this profile)
    scope: text("scope", {
      enum: [
        ProfileScope.SYSTEM,
        ProfileScope.SHARED,
        ProfileScope.WORKSPACE,
        ProfileScope.USER,
      ],
    })
      .notNull()
      .default(ProfileScope.WORKSPACE),

    // Ownership (based on scope)
    userId: text("user_id"), // If scope = "user"
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }), // If scope = "workspace"

    // Metadata
    isActive: boolean("is_active").default(true).notNull(),
    version: integer("version").default(1).notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // NOTE: slug uniqueness is enforced via partial DB indexes (migration 0052):
    //   - system + shared: unique(slug) globally
    //   - workspace: unique(slug, workspace_id)
    //   - user: unique(slug, user_id)
    // The old global unique("profiles_slug_unique") has been dropped.
    parentProfileIdx: index("profiles_parent_profile_id_idx").on(
      table.parentProfileId
    ),
    scopeIdx: index("profiles_scope_idx").on(
      table.scope,
      table.workspaceId,
      table.userId
    ),
  })
);

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertProfileSchema = createInsertSchema(profiles);
export const selectProfileSchema = createSelectSchema(profiles);

/**
 * profile_workspace_access
 *
 * Join table for ProfileScope.SHARED profiles.
 * Allows a profile created in one workspace to be explicitly made available
 * to a specific set of other workspaces without being fully system-scoped.
 *
 * Rows are created by grantAccess() and removed when the workspace is deleted.
 */
export const profileWorkspaceAccess = pgTable(
  "profile_workspace_access",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.profileId, table.workspaceId] }),
    workspaceIdx: index("profile_workspace_access_workspace_idx").on(
      table.workspaceId
    ),
  })
);

export type ProfileWorkspaceAccess = typeof profileWorkspaceAccess.$inferSelect;
