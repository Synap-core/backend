/**
 * User Preferences Schema - UI and application settings
 *
 * Stores user-specific preferences that persist across sessions
 */

import { pgTable, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";

// Type definitions for JSONB columns — declared once in
// `@synap-core/types/preferences/model` (the wire shape), imported here to type
// the columns and re-exported for pod code.
import type {
  CustomTheme,
  DefaultTemplates,
  CustomEntityType,
  EntityMetadataSchemas,
  UIPreferences,
  GraphPreferences,
} from "@synap-core/types/preferences/model";

export type {
  CustomTheme,
  DefaultTemplates,
  CustomEntityType,
  EntityMetadataSchemas,
  EntityOpenMode,
  UIPreferences,
  GraphPreferences,
} from "@synap-core/types/preferences/model";

export const userPreferences = pgTable("user_preferences", {
  // Primary key
  userId: text("user_id").primaryKey(),

  // Theme Preferences
  theme: text("theme").default("system").notNull(), // 'light' | 'dark' | 'system'
  customTheme: jsonb("custom_theme").$type<CustomTheme>(),

  // Template Preferences
  defaultTemplates: jsonb("default_templates").$type<DefaultTemplates>(),

  // Entity Customization
  customEntityTypes: jsonb("custom_entity_types").$type<CustomEntityType[]>(),
  entityMetadataSchemas: jsonb(
    "entity_metadata_schemas"
  ).$type<EntityMetadataSchemas>(),

  // UI Preferences
  uiPreferences: jsonb("ui_preferences")
    .$type<UIPreferences>()
    .default({})
    .notNull(),

  // Graph Preferences
  graphPreferences: jsonb("graph_preferences")
    .$type<GraphPreferences>()
    .default({})
    .notNull(),

  // Intelligence Service Preferences
  intelligenceServicePreferences: jsonb("intelligence_service_preferences")
    .$type<{
      default?: string; // serviceId for general use
      chat?: string; // serviceId specifically for chat
      analysis?: string; // for future capabilities
      /**
       * USER-level default companion adjunct (agent-system id). When the
       * companion / AI entry door opens without an explicit agentSystemId,
       * this is used as the fallback. Orthogonal to the per-workspace
       * intelligenceServiceId — this is a personal default, NOT per-channel
       * routing. Unset → current behavior (workspace default).
       */
      defaultCompanionAgentId?: string;
    }>()
    .default({})
    .notNull(),

  // Onboarding
  onboardingCompleted: boolean("onboarding_completed").default(false).notNull(),
  onboardingStep: text("onboarding_step"),

  /**
   * When the person last had Home on screen — stamped when Home LEAVES the
   * screen (`preferences.markHomeSeen`), read by `lifecycle.home` as the
   * brief's "while you were away" window. Pod-side so it follows the person
   * across devices (0333). Null = never stamped.
   */
  homeLastSeenAt: timestamp("home_last_seen_at", {
    mode: "date",
    withTimezone: true,
  }),

  // Timestamps
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserPreference = typeof userPreferences.$inferSelect;
export type NewUserPreference = typeof userPreferences.$inferInsert;

import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertUserPreferenceSchema = createInsertSchema(userPreferences);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectUserPreferenceSchema = createSelectSchema(userPreferences);
