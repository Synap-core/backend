/**
 * Template Types
 *
 * The `entity_templates` row is declared in ./rows.js; @synap/database proves
 * its inferred row equal (packages/database/src/wire-parity/templates.ts). The
 * table's drizzle-zod schemas (insert/selectEntityTemplateSchema) live with the
 * table in @synap/database; only UI-specific Zod schemas live in this package.
 */

// ============================================================================
// ROW TYPES
// ============================================================================

export type { EntityTemplate, NewEntityTemplate } from "./rows.js";

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
