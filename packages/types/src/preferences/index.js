/**
 * User Preferences Types - SSOT from Database
 *
 * Re-exports database schemas and types. Only UI-specific Zod schemas
 * remain in this package for validation.
 */
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
//# sourceMappingURL=index.js.map
