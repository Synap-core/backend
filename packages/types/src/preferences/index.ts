/**
 * User Preferences Types
 *
 * The row and its JSONB shapes are declared in ./model.js (the wire shape);
 * @synap/database imports them and proves its inferred row equal. Only
 * UI-specific Zod schemas remain alongside for validation.
 */

export type {
  UserPreference,
  NewUserPreference,
  CustomTheme,
  DefaultTemplates,
  CustomEntityType,
  EntityMetadataSchemas,
  EntityOpenMode,
  UIPreferences,
  GraphPreferences,
} from "./model.js";

// NOTE: Zod schemas (insertUserPreferenceSchema, selectUserPreferenceSchema)
// live with the drizzle table in @synap/database and are not part of this
// package.

// ============================================================================
// UI-SPECIFIC SCHEMAS (Frontend Validation)
// ============================================================================

// Re-export UI-specific Zod schemas for frontend validation
export {
  CustomThemeSchema,
  UIPreferencesSchema,
  GraphPreferencesSchema,
  UpdatePreferencesInputSchema,
} from "./schemas.js";

// Theme type (for backwards compatibility)
export type Theme = "light" | "dark" | "system";
