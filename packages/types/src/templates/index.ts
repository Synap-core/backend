/**
 * Template Types - SSOT from Database
 *
 * Re-exports database schemas and types. Only UI-specific Zod schemas
 * remain in this package for layout/styling validation.
 */

// ============================================================================
// DATABASE RE-EXPORTS (Single Source of Truth)
// ============================================================================

export type { EntityTemplate, NewEntityTemplate } from "@synap/database/schema";

export {
  insertEntityTemplateSchema,
  selectEntityTemplateSchema,
} from "@synap/database/schema";

// ============================================================================
// UI-SPECIFIC SCHEMAS (Layout & Styling Configuration)
// ============================================================================

// Re-export UI-specific template configuration schemas
export {
  // Target & Types
  TemplateTargetTypeSchema,
  SectionTypeSchema,
  LayoutZoneSchema,

  // Layout Configuration (UI-specific)
  ZoneConfigSchema,
  LayoutStructureSchema,
  FieldRendererTypeSchema,
  FieldRendererConfigSchema,
  FieldSlotMappingSchema,
  TemplateLayoutConfigSchema,

  // Styling Configuration  (UI-specific)
  TemplateColorsConfigSchema,
  TemplateStylingConfigSchema,
  TemplateConfigSchema,

  // API Input Schemas
  ListTemplatesInputSchema,
  GetDefaultTemplateInputSchema,
  CreateTemplateInputSchema,
  UpdateTemplateInputSchema,
  DuplicateTemplateInputSchema,
  SetDefaultTemplateInputSchema,
  DeleteTemplateInputSchema,
} from "./schemas.js";

// Re-export types
export * from "./types.js";

// ============================================================================
// DEFAULT TEMPLATES (Concrete Data)
// ============================================================================

export { notionLikeTemplate } from "./notion-like.template.js";
export { classicNoteTemplate } from "./classic-note.template.js";
export { wikiReferenceTemplate } from "./wiki-reference.template.js";
