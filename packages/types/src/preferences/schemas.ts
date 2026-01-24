/**
 * User Preferences Schemas - UI-Specific Validation Only
 *
 * Database schemas come from @synap/database/schema
 * This file contains ONLY frontend/UI-specific Zod schemas
 */

import { z } from "zod";

// ============================================================================
// UI-SPECIFIC SCHEMAS (Not in database)
// ============================================================================

// Custom Theme Schema (nested JSONB validation for UI)
export const CustomThemeSchema = z
  .object({
    colors: z
      .object({
        primary: z.string().optional(),
        accent: z.string().optional(),
        background: z.string().optional(),
        border: z.string().optional(),
        text: z.string().optional(),
      })
      .optional(),
    spacing: z
      .object({
        small: z.string().optional(),
        medium: z.string().optional(),
        large: z.string().optional(),
      })
      .optional(),
    radii: z
      .object({
        small: z.string().optional(),
        medium: z.string().optional(),
        large: z.string().optional(),
      })
      .optional(),
    animations: z
      .object({
        enabled: z.boolean().optional(),
        speed: z.enum(["slow", "normal", "fast"]).optional(),
      })
      .optional(),
  })
  .optional();

// UI Preferences Schema (nested JSONB validation for UI)
export const UIPreferencesSchema = z
  .object({
    sidebarCollapsed: z.boolean().optional(),
    panelPositions: z
      .record(
        z.string(),
        z.object({
          x: z.number(),
          y: z.number(),
        })
      )
      .optional(),
    lastActiveView: z.string().optional(),
    compactMode: z.boolean().optional(),
    fontSize: z.string().optional(),
    animations: z.boolean().optional(),
    defaultView: z.enum(["list", "grid", "timeline"]).optional(),
  })
  .optional();

// Graph Preferences Schema (nested JSONB validation for UI)
export const GraphPreferencesSchema = z
  .object({
    forceSettings: z
      .object({
        linkDistance: z.number().optional(),
        chargeStrength: z.number().optional(),
        alphaDecay: z.number().optional(),
        velocityDecay: z.number().optional(),
      })
      .optional(),
    defaultFilters: z
      .object({
        entityTypes: z.array(z.string()).optional(),
        relationTypes: z.array(z.string()).optional(),
      })
      .optional(),
    zoom: z.number().optional(),
    pan: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .optional(),
    showMinimap: z.boolean().optional(),
  })
  .optional();

// ============================================================================
// API INPUT SCHEMAS (All fields optional for partial updates)
// ============================================================================

export const UpdatePreferencesInputSchema = z.object({
  theme: z.enum(["light", "dark", "system"]).optional(),
  customTheme: CustomThemeSchema,
  defaultTemplates: z.record(z.string(), z.string()).optional(),
  customEntityTypes: z.array(z.any()).optional(),
  entityMetadataSchemas: z
    .record(z.string(), z.record(z.string(), z.any()))
    .optional(),
  uiPreferences: UIPreferencesSchema,
  graphPreferences: GraphPreferencesSchema,
  onboardingCompleted: z.boolean().optional(),
  onboardingStep: z.string().optional(),
});
