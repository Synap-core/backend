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
  UIPreferences,
  GraphPreferences,
} from "../../../database/src/schema/index.js";

export {
  insertUserPreferenceSchema,
  selectUserPreferenceSchema,
} from "../../../database/src/schema/index.js";

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
