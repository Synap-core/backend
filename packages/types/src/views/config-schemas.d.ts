/**
 * View Config Schemas
 *
 * Zod schemas for runtime validation of view configs.
 * Each view type has its own config schema.
 */
import { type z } from "zod";
/**
 * Table view config
 */
export declare const TableViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    rowHeight: z.ZodOptional<
      z.ZodEnum<{
        default: "default";
        compact: "compact";
        tall: "tall";
      }>
    >;
    stickyColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaultSort: z.ZodOptional<
      z.ZodObject<
        {
          field: z.ZodString;
          direction: z.ZodEnum<{
            asc: "asc";
            desc: "desc";
          }>;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
/**
 * Kanban view config
 * groupByField optional so partial/empty config on load doesn't fail validation; frontend applies default (e.g. metadata.status)
 */
export declare const KanbanViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    groupByField: z.ZodOptional<z.ZodString>;
    cardFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
    cardSettings: z.ZodOptional<
      z.ZodObject<
        {
          coverField: z.ZodOptional<z.ZodString>;
          showAvatars: z.ZodOptional<z.ZodBoolean>;
          visibleFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
          colorField: z.ZodOptional<z.ZodString>;
        },
        z.core.$strip
      >
    >;
  },
  z.core.$strip
>;
/**
 * List view config
 */
export declare const ListViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    groupByField: z.ZodOptional<z.ZodString>;
    cardFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
>;
/**
 * Grid view config
 */
export declare const GridViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    cardFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
    cardSize: z.ZodOptional<
      z.ZodEnum<{
        small: "small";
        medium: "medium";
        large: "large";
      }>
    >;
  },
  z.core.$strip
>;
/**
 * Gallery view config
 */
export declare const GalleryViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    imageField: z.ZodOptional<z.ZodString>;
    cardFields: z.ZodOptional<z.ZodArray<z.ZodString>>;
  },
  z.core.$strip
>;
/**
 * Calendar view config
 * dateField optional so partial config on load doesn't fail validation
 */
export declare const CalendarViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    dateField: z.ZodOptional<z.ZodString>;
    endDateField: z.ZodOptional<z.ZodString>;
    colorField: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Gantt view config
 * dateField/endDateField optional so partial config on load doesn't fail validation
 */
export declare const GanttViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    dateField: z.ZodOptional<z.ZodString>;
    endDateField: z.ZodOptional<z.ZodString>;
    groupByField: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Timeline view config
 * timeField optional so partial config on load doesn't fail validation
 */
export declare const TimelineViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    timeField: z.ZodOptional<z.ZodString>;
    groupByField: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Graph view config
 */
export declare const GraphViewConfigSchema: z.ZodObject<
  {
    hiddenColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    visibleColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnOrder: z.ZodOptional<z.ZodArray<z.ZodString>>;
    columnWidths: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodNumber>>;
    pinnedColumns: z.ZodOptional<z.ZodArray<z.ZodString>>;
    layout: z.ZodOptional<
      z.ZodEnum<{
        force: "force";
        hierarchical: "hierarchical";
        circular: "circular";
      }>
    >;
    showRelations: z.ZodOptional<z.ZodBoolean>;
    nodeColorField: z.ZodOptional<z.ZodString>;
    edgeLabelField: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Bento grid view config
 * Standalone schema (not extending base - composite view type)
 */
export declare const BentoViewConfigSchema: z.ZodObject<
  {
    layout: z.ZodDefault<
      z.ZodEnum<{
        grid: "grid";
        bento: "bento";
        flow: "flow";
      }>
    >;
    breakpoints: z.ZodOptional<
      z.ZodObject<
        {
          lg: z.ZodOptional<
            z.ZodObject<
              {
                cols: z.ZodNumber;
                rowHeight: z.ZodNumber;
                gap: z.ZodNumber;
              },
              z.core.$strip
            >
          >;
          md: z.ZodOptional<
            z.ZodObject<
              {
                cols: z.ZodNumber;
                rowHeight: z.ZodNumber;
                gap: z.ZodNumber;
              },
              z.core.$strip
            >
          >;
          sm: z.ZodOptional<
            z.ZodObject<
              {
                cols: z.ZodNumber;
                rowHeight: z.ZodNumber;
                gap: z.ZodNumber;
              },
              z.core.$strip
            >
          >;
        },
        z.core.$strip
      >
    >;
    blocks: z.ZodArray<
      z.ZodDiscriminatedUnion<
        [
          z.ZodObject<
            {
              id: z.ZodString;
              kind: z.ZodLiteral<"view">;
              viewId: z.ZodString;
              pos: z.ZodObject<
                {
                  x: z.ZodNumber;
                  y: z.ZodNumber;
                  w: z.ZodNumber;
                  h: z.ZodNumber;
                },
                z.core.$strip
              >;
              overrides: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              id: z.ZodString;
              kind: z.ZodLiteral<"entity">;
              entityId: z.ZodString;
              pos: z.ZodObject<
                {
                  x: z.ZodNumber;
                  y: z.ZodNumber;
                  w: z.ZodNumber;
                  h: z.ZodNumber;
                },
                z.core.$strip
              >;
              variant: z.ZodOptional<
                z.ZodEnum<{
                  compact: "compact";
                  detailed: "detailed";
                }>
              >;
            },
            z.core.$strip
          >,
          z.ZodObject<
            {
              id: z.ZodString;
              kind: z.ZodLiteral<"widget">;
              widgetType: z.ZodString;
              query: z.ZodOptional<
                z.ZodObject<
                  {
                    scopeProfileIds: z.ZodArray<z.ZodString>;
                    filters: z.ZodOptional<z.ZodArray<z.ZodAny>>;
                    sorts: z.ZodOptional<z.ZodArray<z.ZodAny>>;
                  },
                  z.core.$strip
                >
              >;
              pos: z.ZodObject<
                {
                  x: z.ZodNumber;
                  y: z.ZodNumber;
                  w: z.ZodNumber;
                  h: z.ZodNumber;
                },
                z.core.$strip
              >;
              config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            },
            z.core.$strip
          >,
        ],
        "kind"
      >
    >;
  },
  z.core.$strip
>;
/**
 * Whiteboard view config (canvas views don't use config, but we define empty schema for consistency)
 */
export declare const WhiteboardViewConfigSchema: z.ZodObject<{}, z.core.$strip>;
/**
 * Mindmap view config (canvas views don't use config, but we define empty schema for consistency)
 */
export declare const MindmapViewConfigSchema: z.ZodObject<{}, z.core.$strip>;
/**
 * Map view types to their config schemas
 */
export declare const VIEW_CONFIG_SCHEMAS: Record<string, z.ZodSchema>;
/**
 * Get config schema for a view type
 *
 * @param viewType - The view type
 * @returns Zod schema for the view type's config
 */
export declare function getConfigSchemaForViewType(
  viewType: string
): z.ZodSchema | null;
/**
 * Validate config against view type schema
 *
 * @param viewType - The view type
 * @param config - The config to validate
 * @returns Validation result with success flag and optional error
 */
export declare function validateViewConfig(
  viewType: string,
  config: unknown
): {
  valid: boolean;
  errors?: z.ZodError;
};
//# sourceMappingURL=config-schemas.d.ts.map
