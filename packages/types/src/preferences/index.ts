/**
 * User Preferences Types - SSOT from Database
 *
 * Re-exports database schemas and types. Only UI-specific Zod schemas
 * remain in this package for validation.
 */

// ============================================================================
// DATABASE RE-EXPORTS (Single Source of Truth)
// ============================================================================

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
} from "@synap/database";

// NOTE: Zod schemas (insertUserPreferenceSchema, selectUserPreferenceSchema)
// intentionally NOT re-exported — they pull in postgres/drizzle which breaks
// browser/Electron builds. Backend consumers should import directly from
// @synap/database.

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
