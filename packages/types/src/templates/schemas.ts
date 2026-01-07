import { z } from 'zod';

// Target Types
export const TemplateTargetTypeSchema = z.enum(['entity', 'document', 'project', 'inbox_item']);

// Layout Schemas
export const SectionTypeSchema = z.enum(['header', 'relations', 'content', 'metadata', 'footer', 'banner', 'sidebar', 'contentBefore', 'contentAfter']);
export const LayoutZoneSchema = z.enum(['banner', 'header', 'sidebar', 'contentBefore', 'content', 'contentAfter', 'footer']);

export const ZoneConfigSchema = z.object({
  enabled: z.boolean(),
  slots: z.array(z.string()).optional(),
  position: z.enum(['left', 'right']).optional(),
  width: z.string().optional(),
  layout: z.enum(['horizontal', 'vertical']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});

export const LayoutStructureSchema = z.object({
  banner: ZoneConfigSchema.optional(),
  header: ZoneConfigSchema.optional(),
  sidebar: ZoneConfigSchema.optional(),
  contentBefore: ZoneConfigSchema.optional(),
  content: ZoneConfigSchema.optional(),
  contentAfter: ZoneConfigSchema.optional(),
  footer: ZoneConfigSchema.optional(),
});

// Field Renderer Schemas
export const FieldRendererTypeSchema = z.enum([
  'text', 'badge', 'avatar', 'date', 'progress', 'checkbox', 'link', 'number', 'currency', 'relations'
]);

export const FieldRendererConfigSchema = z.object({
  type: FieldRendererTypeSchema,
  variant: z.string().optional(),
  size: z.string().optional(),
  format: z.string().optional(),
  appearance: z.enum(['compact', 'detailed', 'cards']).optional(),
});

export const FieldSlotMappingSchema = z.object({
  slot: z.string(),
  renderer: FieldRendererConfigSchema.optional(),
  label: z.string().optional(),
  showLabel: z.boolean().optional(),
  order: z.number().optional(),
});

export const TemplateLayoutConfigSchema = z.object({
  structure: LayoutStructureSchema,
  fieldMapping: z.record(z.string(), FieldSlotMappingSchema),
});

// Colors & Styling
export const TemplateColorsConfigSchema = z.object({
  primary: z.string().optional(),
  accent: z.string().optional(),
  background: z.string().optional(),
  border: z.string().optional(),
  text: z.string().optional(),
  muted: z.string().optional(),
  success: z.string().optional(),
  warning: z.string().optional(),
  error: z.string().optional(),
});

export const TemplateStylingConfigSchema = z.object({
  borderRadius: z.string().optional(),
  padding: z.string().optional(),
  gap: z.string().optional(),
  fontSize: z.string().optional(),
  fontWeight: z.string().optional(),
  shadow: z.string().optional(),
  fontFamily: z.string().optional(),
});

// Complete Config
export const TemplateConfigSchema = z.object({
  layout: TemplateLayoutConfigSchema.optional(),
  colors: TemplateColorsConfigSchema.optional(),
  styling: TemplateStylingConfigSchema.optional(),
});

// ============================================================================
// NOTE: EntityTemplateSchema was removed (lines 86-118)
// Now exported from @synap/database/schema as:
// - insertEntityTemplateSchema (for API inputs)
// - selectEntityTemplateSchema (for API outputs)
// ============================================================================

// =============================================================================
// API INPUT SCHEMAS
// =============================================================================

// Entity Template Schema
export const EntityTemplateSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().nullable().optional(),
  workspaceId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().optional(),
  targetType: TemplateTargetTypeSchema,
  entityType: z.string().nullable().optional(),
  inboxItemType: z.string().nullable().optional(),
  config: TemplateConfigSchema,
  isDefault: z.boolean().default(false),
  isPublic: z.boolean().default(false),
  version: z.number().int().positive().default(1),
  createdAt: z.date().or(z.string().datetime()),
  updatedAt: z.date().or(z.string().datetime()),
}).refine(
  (data) => {
    // Validate target_type requirements
    if (data.targetType === 'entity' && !data.entityType) return false;
    if (data.targetType === 'inbox_item' && !data.inboxItemType) return false;
    if (data.targetType === 'document' && (data.entityType || data.inboxItemType)) return false;
    if (data.targetType === 'project' && (data.entityType || data.inboxItemType)) return false;
    
    // Validate scope
    if (data.userId && data.workspaceId) return false;
    if (!data.userId && !data.workspaceId) return false;
    
    return true;
  },
  {
    message: "Invalid template configuration",
  }
);

// =============================================================================
// API Input Schemas
// =============================================================================

export const ListTemplatesInputSchema = z.object({
  targetType: TemplateTargetTypeSchema.optional(),
  entityType: z.string().optional(),
  inboxItemType: z.string().optional(),
  workspaceId: z.string().uuid().optional(),
  includePublic: z.boolean().default(false),
});

export const GetDefaultTemplateInputSchema = z.object({
  targetType: TemplateTargetTypeSchema,
  entityType: z.string().optional(),
  inboxItemType: z.string().optional(),
  workspaceId: z.string().uuid().optional(),
});

export const CreateTemplateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  targetType: TemplateTargetTypeSchema,
  entityType: z.string().optional(),
  inboxItemType: z.string().optional(),
  config: TemplateConfigSchema,
  isDefault: z.boolean().default(false),
  isPublic: z.boolean().default(false),
  workspaceId: z.string().uuid().optional(),
});

export const UpdateTemplateInputSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  config: TemplateConfigSchema.optional(),
  isDefault: z.boolean().optional(),
  isPublic: z.boolean().optional(),
});

export const DuplicateTemplateInputSchema = z.object({
  id: z.string().uuid(),
});

export const SetDefaultTemplateInputSchema = z.object({
  id: z.string().uuid(),
});

export const DeleteTemplateInputSchema = z.object({
  id: z.string().uuid(),
});
