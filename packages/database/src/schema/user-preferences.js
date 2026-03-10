/**
 * User Preferences Schema - UI and application settings
 *
 * Stores user-specific preferences that persist across sessions
 */
import { pgTable, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";
export const userPreferences = pgTable("user_preferences", {
  // Primary key
  userId: text("user_id").primaryKey(),
  // Theme Preferences
  theme: text("theme").default("system").notNull(), // 'light' | 'dark' | 'system'
  customTheme: jsonb("custom_theme").$type(),
  // Template Preferences
  defaultTemplates: jsonb("default_templates").$type(),
  // Entity Customization
  customEntityTypes: jsonb("custom_entity_types").$type(),
  entityMetadataSchemas: jsonb("entity_metadata_schemas").$type(),
  // UI Preferences
  uiPreferences: jsonb("ui_preferences").$type().default({}).notNull(),
  // Graph Preferences
  graphPreferences: jsonb("graph_preferences").$type().default({}).notNull(),
  // Intelligence Service Preferences
  intelligenceServicePreferences: jsonb("intelligence_service_preferences")
    .$type()
    .default({})
    .notNull(),
  // Onboarding
  onboardingCompleted: boolean("onboarding_completed").default(false).notNull(),
  onboardingStep: text("onboarding_step"),
  // Timestamps
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertUserPreferenceSchema = createInsertSchema(userPreferences);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectUserPreferenceSchema = createSelectSchema(userPreferences);
//# sourceMappingURL=user-preferences.js.map
