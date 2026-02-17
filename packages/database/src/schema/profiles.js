/**
 * Profiles Schema (Entity Types)
 *
 * Profiles define entity types as configuration, not code.
 * Supports inheritance via parent_profile_id (e.g., "webinar" extends "event").
 */
import { pgTable, uuid, text, jsonb, boolean, integer, timestamp, index, unique, } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
/**
 * Profile Scope
 */
export var ProfileScope;
(function (ProfileScope) {
    ProfileScope["SYSTEM"] = "system";
    ProfileScope["WORKSPACE"] = "workspace";
    ProfileScope["USER"] = "user";
})(ProfileScope || (ProfileScope = {}));
export const profiles = pgTable("profiles", {
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
    // Scope (who can use this profile)
    scope: text("scope", {
        enum: [ProfileScope.SYSTEM, ProfileScope.WORKSPACE, ProfileScope.USER],
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
}, (table) => ({
    slugIdx: unique("profiles_slug_unique").on(table.slug),
    parentProfileIdx: index("profiles_parent_profile_id_idx").on(table.parentProfileId),
    scopeIdx: index("profiles_scope_idx").on(table.scope, table.workspaceId, table.userId),
}));
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertProfileSchema = createInsertSchema(profiles);
export const selectProfileSchema = createSelectSchema(profiles);
//# sourceMappingURL=profiles.js.map