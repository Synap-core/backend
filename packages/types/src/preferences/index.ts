/**
 * User Preferences Types
 */

// Database types
export type { UserPreference, NewUserPreference } from '@synap/database/schema';

// Zod schemas and types (includes CustomTheme, DefaultTemplates, etc.)
export * from './schemas.js';

// Theme type (for backwards compatibility)
export type Theme = 'light' | 'dark' | 'system';
