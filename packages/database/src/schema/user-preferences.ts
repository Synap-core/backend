/**
 * User Preferences Schema - UI and application settings
 * 
 * Stores user-specific preferences that persist across sessions
 */

import { pgTable, text, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';

// Type definitions for JSONB columns
export interface CustomTheme {
  colors?: {
    primary?: string;
    accent?: string;
    background?: string;
    border?: string;
    text?: string;
  };
  spacing?: {
    small?: string;
    medium?: string;
    large?: string;
  };
  radii?: {
    small?: string;
    medium?: string;
    large?: string;
  };
  animations?: {
    enabled?: boolean;
    speed?: 'slow' | 'normal' | 'fast';
  };
}

export interface DefaultTemplates {
  [entityType: string]: string; // entityType -> templateId
}

export interface CustomEntityType {
  id: string;
  name: string;
  icon: string;
  color: string;
  metadataSchema: Record<string, any>;
}

export interface EntityMetadataSchemas {
  [entityType: string]: Record<string, any>;
}

export interface UIPreferences {
  sidebarCollapsed?: boolean;
  panelPositions?: Record<string, { x: number; y: number }>;
  lastActiveView?: string;
  compactMode?: boolean;
  fontSize?: string;
  animations?: boolean;
  defaultView?: 'list' | 'grid' | 'timeline';
}

export interface GraphPreferences {
  forceSettings?: {
    linkDistance?: number;
    chargeStrength?: number;
    alphaDecay?: number;
    velocityDecay?: number;
  };
  defaultFilters?: {
    entityTypes?: string[];
    relationTypes?: string[];
  };
  zoom?: number;
  pan?: { x: number; y: number };
  showMinimap?: boolean;
}

export const userPreferences = pgTable('user_preferences', {
  // Primary key
  userId: text('user_id').primaryKey(),
  
  // Theme Preferences
  theme: text('theme').default('system').notNull(), // 'light' | 'dark' | 'system'
  customTheme: jsonb('custom_theme').$type<CustomTheme>(),
  
  // Template Preferences
  defaultTemplates: jsonb('default_templates').$type<DefaultTemplates>(),
  
  // Entity Customization
  customEntityTypes: jsonb('custom_entity_types').$type<CustomEntityType[]>(),
  entityMetadataSchemas: jsonb('entity_metadata_schemas').$type<EntityMetadataSchemas>(),
  
  // UI Preferences
  uiPreferences: jsonb('ui_preferences').$type<UIPreferences>().default({}).notNull(),
  
  // Graph Preferences
  graphPreferences: jsonb('graph_preferences').$type<GraphPreferences>().default({}).notNull(),
  
  // Onboarding
  onboardingCompleted: boolean('onboarding_completed').default(false).notNull(),
  onboardingStep: text('onboarding_step'),
  
  // Timestamps
  updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserPreference = typeof userPreferences.$inferSelect;
export type NewUserPreference = typeof userPreferences.$inferInsert;
