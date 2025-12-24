/**
 * User Preferences Schema - UI and application settings
 * 
 * Stores user-specific preferences that persist across sessions
 */

import { pgTable, text, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';

export const userPreferences = pgTable('user_preferences', {
  // Primary key
  userId: text('user_id').primaryKey(),
  
  // UI Preferences
  theme: text('theme').default('system').notNull(), // 'light' | 'dark' | 'system'
  uiPreferences: jsonb('ui_preferences').default('{}').notNull(),
  // {
  //   sidebarCollapsed: false,
  //   panelPositions: { filterPanel: { x: 100, y: 200 } },
  //   lastActiveView: 'graph',
  //   compactMode: false,
  //   fontSize: 'medium'
  // }
  
  // Graph Preferences
  graphPreferences: jsonb('graph_preferences').default('{}').notNull(),
  // {
  //   forceSettings: {
  //     linkDistance: 150,
  //     chargeStrength: -300,
  //     alphaDecay: 0.08,
  //     velocityDecay: 0.6
  //   },
  //   defaultFilters: {
  //     entityTypes: ['note', 'task'],
  //     relationTypes: ['links_to']
  //   },
  //   zoom: 1.0,
  //   pan: { x: 0, y: 0 },
  //   showMinimap: true
  // }
  
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
