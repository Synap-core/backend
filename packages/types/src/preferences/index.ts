/**
 * User Preferences Types
 * 
 * Re-exports user preferences types from database schema (single source of truth).
 * 
 * Note: Database exports `UserPreference` (singular), we alias to `UserPreferences` for API consistency.
 * 
 * @see {@link file:///.../packages/database/src/schema/user-preferences.ts}
 */

// Direct re-exports from database (with alias for consistency)
export type { 
  UserPreference as UserPreferences,
  NewUserPreference as NewUserPreferences,
} from '@synap/database/schema';

// Derived types
import type { UserPreference } from '@synap/database/schema';

export type Theme = UserPreference['theme'];

// Input types for API operations
export interface UpdatePreferencesInput {
  theme?: Theme;
  uiPreferences?: Record<string, unknown>;
  graphPreferences?: Record<string, unknown>;
  onboardingCompleted?: boolean;
  onboardingStep?: string;
}
