/**
 * View Content Validation Schemas
 *
 * Zod schemas for runtime validation of view content structures.
 */

import { z } from "zod";

// =============================================================================
// Entity Query Schemas
// =============================================================================

/**
 * Entity filter schema
 */
const EntityFilterSchema = z.object({
  field: z.string(),
  operator: z.enum([
    "equals",
    "contains",
    "gt",
    "gte",
    "lt",
    "lte",
    "in",
    "notIn",
    "between",
  ]),
  value: z.unknown(),
});

/**
 * Entity query schema
 */
/**
 * Sort rule schema
 */
const SortRuleSchema = z.object({
  field: z.string(),
  direction: z.enum(["asc", "desc"]),
});

/**
 * Entity query schema
 */
export const EntityQuerySchema = z.object({
  entityTypes: z.array(z.string()).optional(),
  entityIds: z.array(z.string().uuid()).optional(),
  filters: z.array(EntityFilterSchema).optional(),
  sorts: z.array(SortRuleSchema).optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().nonnegative().optional(),
  groupBy: z.string().optional(),
});

// =============================================================================
// Structured View Config Schemas
// =============================================================================

/**
 * Kanban column schema
 */
const KanbanColumnSchema = z.object({
  id: z.string(),
  value: z.string(),
  label: z.string(),
  order: z.number(),
  color: z.string().optional(),
  limit: z.number().optional(),
});

/**
 * Structured view configuration schema
 */
/**
 * Render settings schema (was StructuredViewConfigSchema)
 * Defines layout and display options
 */
export const RenderSettingsSchema = z
  .object({
    layout: z
      .enum([
        "table",
        "kanban",
        "list",
        "grid",
        "gallery",
        "calendar",
        "gantt",
        "timeline",
        "graph",
      ])
      .optional(),

    // Common fields (flexible to allow frontend-specific structures)
    columns: z.array(z.any()).optional(),
    filters: z.array(z.any()).optional(), // Legacy UI filters
    sorts: z.array(z.any()).optional(), // Legacy UI sorts
    groupByColumnId: z.string().optional(),

    // Layout-specific fields
    kanbanColumns: z.array(KanbanColumnSchema).optional(),
    calendarDateField: z.string().optional(),
    timelineTimeField: z.string().optional(),
    graphLayout: z.enum(["force", "hierarchical", "circular"]).optional(),
    graphRelationshipTypes: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * Structured view configuration schema
 * Combines query and render settings
 */
export const StructuredViewConfigSchema = z.object({
  category: z.literal("structured"),
  query: EntityQuerySchema,
  render: RenderSettingsSchema.optional(),
});

// =============================================================================
// View Content Schemas
// =============================================================================

/**
 * Structured view content schema
 */
const StructuredViewContentSchema = z
  .object({
    version: z.literal(1),
    category: z.literal("structured"),
    // We use the StructuredViewConfigSchema but unwrap it or use it as part of the content
    // Actually, ViewContent usually IS the config for structured views
    query: EntityQuerySchema,
    render: RenderSettingsSchema.optional(),
  })
  .passthrough(); // Allow extra fields for backward compatibility

/**
 * Canvas view content schema
 */
const CanvasViewContentSchema = z.object({
  version: z.literal(1),
  category: z.literal("canvas"),
  elements: z.array(z.unknown()),
  embeddedEntities: z.array(z.string().uuid()).optional(),
});

/**
 * Discriminated union schema for all view content types
 */
export const ViewContentSchema = z.discriminatedUnion("category", [
  StructuredViewContentSchema,
  CanvasViewContentSchema,
]);

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Parse and validate view content
 * Throws ZodError if validation fails
 *
 * @param raw - Raw content to validate
 * @returns Validated view content
 */
export function parseViewContent(
  raw: unknown,
): z.infer<typeof ViewContentSchema> {
  return ViewContentSchema.parse(raw);
}

/**
 * Safe parse view content
 * Returns success/error result without throwing
 *
 * @param raw - Raw content to validate
 * @returns Parse result with success flag and data/error
 */
export function safeParseViewContent(raw: unknown) {
  return ViewContentSchema.safeParse(raw);
}

/**
 * Validate that content category matches view type
 *
 * @param viewType - The view type from database
 * @param content - The content to validate
 * @returns true if category matches, false otherwise
 */
export function validateContentCategoryForViewType(
  viewType: string,
  content: z.infer<typeof ViewContentSchema>,
): boolean {
  // Map view types to expected categories
  const canvasTypes = ["whiteboard", "mindmap"];
  const expectedCategory = canvasTypes.includes(viewType)
    ? "canvas"
    : "structured";

  return content.category === expectedCategory;
}
