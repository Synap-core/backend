/**
 * View Config Schemas
 *
 * Zod schemas for runtime validation of view configs.
 * Each view type has its own config schema.
 */

import { z } from "zod";
import { RenderSettingsSchema } from "./schemas.js";

// =============================================================================
// Base Config Schema (Common Fields for Structured Views)
// =============================================================================

/**
 * Common config fields shared across structured view types
 * (table, kanban, list, grid, etc.)
 */
const BaseViewConfigSchema = z.object({
  // Column overrides
  hiddenColumns: z.array(z.string()).optional(),
  visibleColumns: z.array(z.string()).optional(),
  columnOrder: z.array(z.string()).optional(),
  columnWidths: z.record(z.string(), z.number()).optional(),
  pinnedColumns: z.array(z.string()).optional(),
});

// =============================================================================
// View Type-Specific Config Schemas
// =============================================================================

/**
 * Table view config
 */
export const TableViewConfigSchema = BaseViewConfigSchema.extend({
  rowHeight: z.enum(["compact", "default", "tall"]).optional(),
  stickyColumns: z.array(z.string()).optional(),
  defaultSort: z
    .object({
      field: z.string(),
      direction: z.enum(["asc", "desc"]),
    })
    .optional(),
});

/**
 * Kanban view config
 * groupByField optional so partial/empty config on load doesn't fail validation; frontend applies default (e.g. metadata.status)
 */
export const KanbanViewConfigSchema = BaseViewConfigSchema.extend({
  groupByField: z.string().optional(),
  cardFields: z.array(z.string()).optional(),
  cardSettings: z
    .object({
      coverField: z.string().optional(),
      showAvatars: z.boolean().optional(),
      visibleFields: z.array(z.string()).optional(),
      colorField: z.string().optional(),
    })
    .optional(),
});

/**
 * List view config
 */
export const ListViewConfigSchema = BaseViewConfigSchema.extend({
  groupByField: z.string().optional(),
  cardFields: z.array(z.string()).optional(),
});

/**
 * Grid view config
 */
export const GridViewConfigSchema = BaseViewConfigSchema.extend({
  cardFields: z.array(z.string()).optional(),
  cardSize: z.enum(["small", "medium", "large"]).optional(),
});

/**
 * Gallery view config
 */
export const GalleryViewConfigSchema = BaseViewConfigSchema.extend({
  imageField: z.string().optional(),
  cardFields: z.array(z.string()).optional(),
});

/**
 * Calendar view config
 * dateField optional so partial config on load doesn't fail validation
 */
export const CalendarViewConfigSchema = BaseViewConfigSchema.extend({
  dateField: z.string().optional(),
  endDateField: z.string().optional(),
  colorField: z.string().optional(),
});

/**
 * Gantt view config
 * dateField/endDateField optional so partial config on load doesn't fail validation
 */
export const GanttViewConfigSchema = BaseViewConfigSchema.extend({
  dateField: z.string().optional(),
  endDateField: z.string().optional(),
  groupByField: z.string().optional(),
});

/**
 * Timeline view config
 * timeField optional so partial config on load doesn't fail validation
 */
export const TimelineViewConfigSchema = BaseViewConfigSchema.extend({
  timeField: z.string().optional(),
  groupByField: z.string().optional(),
});

/**
 * Graph view config
 */
export const GraphViewConfigSchema = BaseViewConfigSchema.extend({
  layout: z.enum(["force", "hierarchical", "circular"]).optional(),
  showRelations: z.boolean().optional(),
  nodeColorField: z.string().optional(),
  edgeLabelField: z.string().optional(),
});

/**
 * Sheet persists the structured render contract, including its validated
 * live-block references. Reuse RenderSettingsSchema so the API config write
 * door applies the same validation as view-content parsing.
 */
export const SheetViewConfigSchema = RenderSettingsSchema;

/**
 * Bento grid view config
 * Standalone schema (not extending base - composite view type)
 */
/**
 * Per-block surface treatment ("chrome"). `auto` defers to the widget's default
 * (resolveDefaultBentoWidgetChrome on the frontend). MUST be persisted, so it is
 * part of every block schema below — otherwise Zod strips it on save and the
 * user's surface-style choice is lost on reload.
 */
export const BentoBlockChromeSchema = z
  .enum(["auto", "none", "soft", "card", "inset", "hero"])
  .optional();

export const BentoViewConfigSchema = z.object({
  layout: z.enum(["bento", "grid", "flow"]).default("bento"),
  breakpoints: z
    .object({
      lg: z
        .object({
          cols: z.number().int().positive(),
          rowHeight: z.number().int().positive(),
          gap: z.number().int().nonnegative(),
        })
        .optional(),
      md: z
        .object({
          cols: z.number().int().positive(),
          rowHeight: z.number().int().positive(),
          gap: z.number().int().nonnegative(),
        })
        .optional(),
      sm: z
        .object({
          cols: z.number().int().positive(),
          rowHeight: z.number().int().positive(),
          gap: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .optional(),
  blocks: z.array(
    z.discriminatedUnion("kind", [
      // View block
      z.object({
        id: z.string(),
        kind: z.literal("view"),
        viewId: z.string().uuid(),
        pos: z.object({
          x: z.number().int().nonnegative(),
          y: z.number().int().nonnegative(),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        }),
        overrides: z.record(z.string(), z.unknown()).optional(),
        chrome: BentoBlockChromeSchema,
      }),
      // Entity block
      z.object({
        id: z.string(),
        kind: z.literal("entity"),
        entityId: z.string().uuid(),
        pos: z.object({
          x: z.number().int().nonnegative(),
          y: z.number().int().nonnegative(),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        }),
        variant: z.enum(["compact", "detailed"]).optional(),
        chrome: BentoBlockChromeSchema,
      }),
      // Widget block (widgetType = opaque string; frontend registry decides renderer)
      z.object({
        id: z.string(),
        kind: z.literal("widget"),
        widgetType: z.string().min(1),
        query: z
          .object({
            scopeProfileIds: z.array(z.string().uuid()),
            filters: z.array(z.any()).optional(),
            sorts: z.array(z.any()).optional(),
          })
          .optional(),
        pos: z.object({
          x: z.number().int().nonnegative(),
          y: z.number().int().nonnegative(),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        }),
        config: z.record(z.string(), z.unknown()).optional(),
        chrome: BentoBlockChromeSchema,
      }),
    ])
  ),
});

// =============================================================================
// Canvas View Config Schemas
// =============================================================================

/**
 * Whiteboard view config (canvas views don't use config, but we define empty schema for consistency)
 */
export const WhiteboardViewConfigSchema = z.object({});

/**
 * Mindmap view config (canvas views don't use config, but we define empty schema for consistency)
 */
export const MindmapViewConfigSchema = z.object({});

// =============================================================================
// View Type → Schema Mapping
// =============================================================================

/**
 * Map view types to their config schemas
 */
export const VIEW_CONFIG_SCHEMAS: Record<string, z.ZodSchema> = {
  table: TableViewConfigSchema,
  kanban: KanbanViewConfigSchema,
  list: ListViewConfigSchema,
  grid: GridViewConfigSchema,
  gallery: GalleryViewConfigSchema,
  calendar: CalendarViewConfigSchema,
  gantt: GanttViewConfigSchema,
  timeline: TimelineViewConfigSchema,
  graph: GraphViewConfigSchema,
  sheet: SheetViewConfigSchema,
  bento: BentoViewConfigSchema,
  whiteboard: WhiteboardViewConfigSchema,
  mindmap: MindmapViewConfigSchema,
};

/**
 * Get config schema for a view type
 *
 * @param viewType - The view type
 * @returns Zod schema for the view type's config
 */
export function getConfigSchemaForViewType(
  viewType: string
): z.ZodSchema | null {
  return VIEW_CONFIG_SCHEMAS[viewType] || null;
}

/**
 * Validate config against view type schema
 *
 * @param viewType - The view type
 * @param config - The config to validate
 * @returns Validation result with success flag and optional error
 */
export function validateViewConfig(
  viewType: string,
  config: unknown
): { valid: boolean; errors?: z.ZodError } {
  const schema = getConfigSchemaForViewType(viewType);

  if (!schema) {
    // Unknown view type - allow any config (backward compatibility)
    return { valid: true };
  }

  const result = schema.safeParse(config);

  if (result.success) {
    return { valid: true };
  }

  return { valid: false, errors: result.error };
}
