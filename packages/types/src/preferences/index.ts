/**
 * User Preferences Types
 * 
 * Re-exports user preferences types from database schema (single source of truth).
 * 
 * @see {@link @synap-core/database/schema}
 */

// Direct re-exports from database
export type { 
  UserPreference as UserPreferences,
  NewUserPreference as NewUserPreferences,
} from '@synap-core/database/schema';

// Derived types
import type { UserPreference } from '@synap-core/database/schema';

export type Theme = UserPreference['theme'];

// Input types for API operations
export interface UpdatePreferencesInput {
  theme?: Theme;
  uiPreferences?: Record<string, unknown>;
  graphPreferences?: Record<string, unknown>;
  onboardingCompleted?: boolean;
  onboardingStep?: string;
}
