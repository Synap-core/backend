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

/**
 * Per-kind behavioral emphases for AI teaching briefs (base layer). Workspace
 * overlay lives at `workspaces.settings.profileAiPosture[slug]` (jsonb,
 * already exists) — resolved together by `getEffectiveAiPosture()`.
 */
export interface AiPosture {
  explainWhy?: boolean;
  openAfterCreate?: boolean;
  attachOutputs?: boolean;
  directives?: string[];
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

    // Entity scoping — determines whether entities of this profile type
    // are pod-wide (visible in all workspaces) or workspace-scoped.
    // Pod-wide: Person, Company, Note, Task (core types shared everywhere)
    // Workspace-scoped: Deal, Pipeline, custom types (app-specific)
    entityScope: text("entity_scope", {
      enum: ["pod", "workspace"],
    })
      .notNull()
      .default("workspace"),

    // ─── Profile Renderer North Star ─────────────────────────────────────────
    // System-default renderer choice per slot.
    // Shape: RendererTarget (from @synap-core/renderer-runtime).
    //   { kind: 'cell',          cellKey, props }      — config path
    //   { kind: 'view',          viewId }              — config path (saved view)
    //   { kind: 'iframe-srcdoc', appId, srcdoc }       — file path (inline)
    //   { kind: 'external-app',  appId, url }          — file path (pod-served URL)
    // NULL means "fall back to system default" in getEffectiveRenderer().
    // Workspace overrides live in workspaces.settings.profileRenderers[slug].
    // Migration: 0024_profile_renderer_columns.sql
    /** @deprecated Use `defaultRenderers['collection']`. Kept (migration 0112). */
    defaultListRenderer: jsonb("default_list_renderer"),
    /** @deprecated Use `defaultRenderers['entity-detail']`. Kept (migration 0112). */
    defaultDetailRenderer: jsonb("default_detail_renderer"),
    /** @deprecated Use `defaultRenderers['entity-profile']`. Kept (migration 0112). */
    defaultDashboardRenderer: jsonb("default_dashboard_renderer"),

    // The profile's renderers, keyed by RendererType (the single taxonomy that
    // replaces the old list/detail/dashboard "slots"). One RendererTarget per
    // type — `{ entity-detail?, entity-profile?, collection? }`. A missing key
    // means "fall back to system default" in getEffectiveRenderer(). Workspace
    // overrides live in workspaces.settings.profileRenderers[slug]. See 0112.
    defaultRenderers: jsonb("default_renderers")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    // Kind + Facets (0174): a profile is either the entity's primary 'kind'
    // (default — every pre-existing profile) or an attachable 'role' (facet)
    // usable via entity_facets. `applicableKinds` optionally restricts a role
    // profile to specific kind slugs (NULL = any kind).
    profileKind: text("profile_kind", { enum: ["kind", "role"] })
      .notNull()
      .default("kind"),
    applicableKinds: text("applicable_kinds").array(),

    // AI teaching substrate: per-kind posture base layer (see AiPosture above).
    // NULL means "fall back to code defaults" in getEffectiveAiPosture().
    aiPosture: jsonb("ai_posture").$type<AiPosture>(),

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
