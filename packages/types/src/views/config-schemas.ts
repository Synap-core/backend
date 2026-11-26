/**
 * View Config Schemas
 *
 * Zod schemas for runtime validation of view configs.
 * Each view type has its own config schema.
 */

import { z } from "zod";
import { RenderSettingsSchema } from "./schemas.js";
import {
  CellBlockSchema,
  EntityBlockSchema,
  ViewBlockSchema,
  cellBlockIssues,
} from "../blocks/index.js";

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

/** Where a bento tile sits (12-column grid units): the bento's `place`. */
const BentoPosSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  w: z.number().int().positive(),
  h: z.number().int().positive(),
});

/** What every stored bento tile carries beside its Block. */
const BentoTileFields = {
  id: z.string(),
  pos: BentoPosSchema,
  chrome: BentoBlockChromeSchema,
};

/** A tile's data query (a cell tile's, legacy or canonical): bento-local, not part of the Block. */
const BentoTileQuerySchema = z
  .object({
    scopeProfileIds: z.array(z.string().uuid()),
    filters: z.array(z.any()).optional(),
    sorts: z.array(z.any()).optional(),
  })
  .optional();

/**
 * A stored bento tile = the one `Block` (`@synap-core/types/blocks`) + its
 * place (`id`, `pos`, `chrome`). Four arms: the three Block kinds, and the
 * LEGACY `widget` spelling (`widgetType`, `config`, `cellInstanceId`) every
 * stored bento still holds; readers map it with `readLegacyBlock`. The cell
 * arms keep `instanceId` / `cellInstanceId` (this schema used to drop it) and
 * enforce the placement rule (`cellBlockIssues`: a key or an instance, and no
 * inline props on an instance).
 */
export const BentoBlockSchema = z
  .discriminatedUnion("kind", [
    ViewBlockSchema.extend(BentoTileFields),
    EntityBlockSchema.extend(BentoTileFields),
    // A bento draws a tile by its key: a cell tile always names it (with or
    // without an instance), never an instance alone.
    CellBlockSchema.extend({
      ...BentoTileFields,
      cellKey: z.string().min(1),
      query: BentoTileQuerySchema,
    }),
    // Legacy cell tile (widgetType = opaque string; the frontend registry decides the renderer).
    z.object({
      ...BentoTileFields,
      kind: z.literal("widget"),
      widgetType: z.string().min(1),
      query: BentoTileQuerySchema,
      config: z.record(z.string(), z.unknown()).optional(),
      cellInstanceId: z.string().min(1).optional(),
    }),
  ])
  .superRefine((tile, ctx) => {
    if (tile.kind === "cell") {
      for (const message of cellBlockIssues(tile))
        ctx.addIssue({ code: "custom", message });
    } else if (tile.kind === "widget") {
      for (const message of cellBlockIssues({
        cellKey: tile.widgetType,
        instanceId: tile.cellInstanceId,
        props: tile.config,
      }))
        ctx.addIssue({ code: "custom", message });
    }
  });
export type StoredBentoBlock = z.infer<typeof BentoBlockSchema>;

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
  blocks: z.array(BentoBlockSchema),
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
