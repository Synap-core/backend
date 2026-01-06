/**
 * User Preferences Schemas - Zod validation
 */

import { z } from 'zod';

// Custom Theme Schema
export const CustomThemeSchema = z.object({
  colors: z.object({
    primary: z.string().optional(),
    accent: z.string().optional(),
    background: z.string().optional(),
    border: z.string().optional(),
    text: z.string().optional(),
  }).optional(),
  spacing: z.object({
    small: z.string().optional(),
    medium: z.string().optional(),
    large: z.string().optional(),
  }).optional(),
  radii: z.object({
    small: z.string().optional(),
    medium: z.string().optional(),
    large: z.string().optional(),
  }).optional(),
  animations: z.object({
    enabled: z.boolean().optional(),
    speed: z.enum(['slow', 'normal', 'fast']).optional(),
  }).optional(),
}).optional();

// Default Templates Schema
export const DefaultTemplatesSchema = z.record(
  z.string(), // entity type
  z.string()  // template ID
).optional();

// Custom Entity Type Schema
export const CustomEntityTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  color: z.string(),
  metadataSchema: z.record(z.any()),
});

// Entity Metadata Schemas
export const EntityMetadataSchemasSchema = z.record(
  z.string(), // entity type
  z.record(z.any()) // field definitions
).optional();

// UI Preferences Schema
export const UIPreferencesSchema = z.object({
  sidebarCollapsed: z.boolean().optional(),
  panelPositions: z.record(z.object({
    x: z.number(),
    y: z.number(),
  })).optional(),
  lastActiveView: z.string().optional(),
  compactMode: z.boolean().optional(),
  fontSize: z.string().optional(),
  animations: z.boolean().optional(),
  defaultView: z.enum(['list', 'grid', 'timeline']).optional(),
}).optional();

// Graph Preferences Schema
export const GraphPreferencesSchema = z.object({
  forceSettings: z.object({
    linkDistance: z.number().optional(),
    chargeStrength: z.number().optional(),
    alphaDecay: z.number().optional(),
    velocityDecay: z.number().optional(),
  }).optional(),
  defaultFilters: z.object({
    entityTypes: z.array(z.string()).optional(),
    relationTypes: z.array(z.string()).optional(),
  }).optional(),
  zoom: z.number().optional(),
  pan: z.object({
    x: z.number(),
    y: z.number(),
  }).optional(),
  showMinimap: z.boolean().optional(),
}).optional();

// Complete User Preferences Schema
export const UserPreferencesSchema = z.object({
  userId: z.string(),
  theme: z.enum(['light', 'dark', 'system']).default('system'),
  customTheme: CustomThemeSchema,
  defaultTemplates: DefaultTemplatesSchema,
  customEntityTypes: z.array(CustomEntityTypeSchema).optional(),
  entityMetadataSchemas: EntityMetadataSchemasSchema,
  uiPreferences: UIPreferencesSchema,
  graphPreferences: GraphPreferencesSchema,
  onboardingCompleted: z.boolean().default(false),
  onboardingStep: z.string().optional(),
  updatedAt: z.date().optional(),
});

// Input schema for API updates (all fields optional except userId)
export const UpdatePreferencesInputSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  customTheme: CustomThemeSchema,
  defaultTemplates: DefaultTemplatesSchema,
  customEntityTypes: z.array(CustomEntityTypeSchema).optional(),
  entityMetadataSchemas: EntityMetadataSchemasSchema,
  uiPreferences: UIPreferencesSchema,
  graphPreferences: GraphPreferencesSchema,
  onboardingCompleted: z.boolean().optional(),
  onboardingStep: z.string().optional(),
});

// Export types
export type CustomTheme = z.infer<typeof CustomThemeSchema>;
export type DefaultTemplates = z.infer<typeof DefaultTemplatesSchema>;
export type CustomEntityType = z.infer<typeof CustomEntityTypeSchema>;
export type EntityMetadataSchemas = z.infer<typeof EntityMetadataSchemasSchema>;
export type UIPreferences = z.infer<typeof UIPreferencesSchema>;
export type GraphPreferences = z.infer<typeof GraphPreferencesSchema>;
export type UserPreferences = z.infer<typeof UserPreferencesSchema>;
export type UpdatePreferencesInput = z.infer<typeof UpdatePreferencesInputSchema>;
