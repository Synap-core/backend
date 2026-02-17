/**
 * User Preferences Types - SSOT from Database
 *
 * Re-exports database schemas and types. Only UI-specific Zod schemas
 * remain in this package for validation.
 */
export type { UserPreference, NewUserPreference, CustomTheme, DefaultTemplates, CustomEntityType, EntityMetadataSchemas, EntityOpenMode, UIPreferences, GraphPreferences, } from "../../../database/src/schema/index.js";
export { insertUserPreferenceSchema, selectUserPreferenceSchema, } from "../../../database/src/schema/index.js";
export { CustomThemeSchema, UIPreferencesSchema, GraphPreferencesSchema, UpdatePreferencesInputSchema, } from "./schemas.js";
export type Theme = "light" | "dark" | "system";
//# sourceMappingURL=index.d.ts.map