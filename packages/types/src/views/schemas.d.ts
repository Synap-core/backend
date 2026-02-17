/**
 * View Content Validation Schemas
 *
 * Zod schemas for runtime validation of view content structures.
 */
import { z } from "zod";
/**
 * Entity query schema
 * NOTE: profileIds/profileSlugs/entityTypes are now stored in views.scopeProfileIds
 * This schema only validates filters, sorts, search, pagination, and groupBy
 */
export declare const EntityQuerySchema: z.ZodObject<
  {
    profileIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    profileSlugs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    entityTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    entityIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
    filters: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            field: z.ZodString;
            operator: z.ZodEnum<{
              in: "in";
              equals: "equals";
              contains: "contains";
              gt: "gt";
              gte: "gte";
              lt: "lt";
              lte: "lte";
              notIn: "notIn";
              between: "between";
            }>;
            value: z.ZodUnknown;
          },
          z.core.$strip
        >
      >
    >;
    sorts: z.ZodOptional<
      z.ZodArray<
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
      >
    >;
    search: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
    offset: z.ZodOptional<z.ZodNumber>;
    groupBy: z.ZodOptional<z.ZodString>;
  },
  z.core.$strip
>;
/**
 * Structured view configuration schema
 */
/**
 * Render settings schema (was StructuredViewConfigSchema)
 * Defines layout and display options
 */
export declare const RenderSettingsSchema: z.ZodObject<
  {
    layout: z.ZodOptional<
      z.ZodEnum<{
        table: "table";
        calendar: "calendar";
        list: "list";
        grid: "grid";
        timeline: "timeline";
        graph: "graph";
        kanban: "kanban";
        gallery: "gallery";
        gantt: "gantt";
      }>
    >;
    columns: z.ZodOptional<z.ZodArray<z.ZodAny>>;
    filters: z.ZodOptional<z.ZodArray<z.ZodAny>>;
    sorts: z.ZodOptional<z.ZodArray<z.ZodAny>>;
    groupByColumnId: z.ZodOptional<z.ZodString>;
    kanbanColumns: z.ZodOptional<
      z.ZodArray<
        z.ZodObject<
          {
            id: z.ZodString;
            value: z.ZodString;
            label: z.ZodString;
            order: z.ZodNumber;
            color: z.ZodOptional<z.ZodString>;
            limit: z.ZodOptional<z.ZodNumber>;
          },
          z.core.$strip
        >
      >
    >;
    calendarDateField: z.ZodOptional<z.ZodString>;
    timelineTimeField: z.ZodOptional<z.ZodString>;
    graphLayout: z.ZodOptional<
      z.ZodEnum<{
        force: "force";
        hierarchical: "hierarchical";
        circular: "circular";
      }>
    >;
    graphRelationshipTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
  },
  z.core.$loose
>;
/**
 * Structured view configuration schema
 * Combines query and render settings
 */
export declare const StructuredViewConfigSchema: z.ZodObject<
  {
    category: z.ZodLiteral<"structured">;
    query: z.ZodObject<
      {
        profileIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        profileSlugs: z.ZodOptional<z.ZodArray<z.ZodString>>;
        entityTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        entityIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
        filters: z.ZodOptional<
          z.ZodArray<
            z.ZodObject<
              {
                field: z.ZodString;
                operator: z.ZodEnum<{
                  in: "in";
                  equals: "equals";
                  contains: "contains";
                  gt: "gt";
                  gte: "gte";
                  lt: "lt";
                  lte: "lte";
                  notIn: "notIn";
                  between: "between";
                }>;
                value: z.ZodUnknown;
              },
              z.core.$strip
            >
          >
        >;
        sorts: z.ZodOptional<
          z.ZodArray<
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
          >
        >;
        search: z.ZodOptional<z.ZodString>;
        limit: z.ZodOptional<z.ZodNumber>;
        offset: z.ZodOptional<z.ZodNumber>;
        groupBy: z.ZodOptional<z.ZodString>;
      },
      z.core.$strip
    >;
    render: z.ZodOptional<
      z.ZodObject<
        {
          layout: z.ZodOptional<
            z.ZodEnum<{
              table: "table";
              calendar: "calendar";
              list: "list";
              grid: "grid";
              timeline: "timeline";
              graph: "graph";
              kanban: "kanban";
              gallery: "gallery";
              gantt: "gantt";
            }>
          >;
          columns: z.ZodOptional<z.ZodArray<z.ZodAny>>;
          filters: z.ZodOptional<z.ZodArray<z.ZodAny>>;
          sorts: z.ZodOptional<z.ZodArray<z.ZodAny>>;
          groupByColumnId: z.ZodOptional<z.ZodString>;
          kanbanColumns: z.ZodOptional<
            z.ZodArray<
              z.ZodObject<
                {
                  id: z.ZodString;
                  value: z.ZodString;
                  label: z.ZodString;
                  order: z.ZodNumber;
                  color: z.ZodOptional<z.ZodString>;
                  limit: z.ZodOptional<z.ZodNumber>;
                },
                z.core.$strip
              >
            >
          >;
          calendarDateField: z.ZodOptional<z.ZodString>;
          timelineTimeField: z.ZodOptional<z.ZodString>;
          graphLayout: z.ZodOptional<
            z.ZodEnum<{
              force: "force";
              hierarchical: "hierarchical";
              circular: "circular";
            }>
          >;
          graphRelationshipTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        },
        z.core.$loose
      >
    >;
  },
  z.core.$strip
>;
/**
 * Discriminated union schema for all view content types
 */
export declare const ViewContentSchema: z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      {
        version: z.ZodLiteral<1>;
        category: z.ZodLiteral<"structured">;
        query: z.ZodObject<
          {
            profileIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
            profileSlugs: z.ZodOptional<z.ZodArray<z.ZodString>>;
            entityTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            entityIds: z.ZodOptional<z.ZodArray<z.ZodString>>;
            filters: z.ZodOptional<
              z.ZodArray<
                z.ZodObject<
                  {
                    field: z.ZodString;
                    operator: z.ZodEnum<{
                      in: "in";
                      equals: "equals";
                      contains: "contains";
                      gt: "gt";
                      gte: "gte";
                      lt: "lt";
                      lte: "lte";
                      notIn: "notIn";
                      between: "between";
                    }>;
                    value: z.ZodUnknown;
                  },
                  z.core.$strip
                >
              >
            >;
            sorts: z.ZodOptional<
              z.ZodArray<
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
              >
            >;
            search: z.ZodOptional<z.ZodString>;
            limit: z.ZodOptional<z.ZodNumber>;
            offset: z.ZodOptional<z.ZodNumber>;
            groupBy: z.ZodOptional<z.ZodString>;
          },
          z.core.$strip
        >;
        render: z.ZodOptional<
          z.ZodObject<
            {
              layout: z.ZodOptional<
                z.ZodEnum<{
                  table: "table";
                  calendar: "calendar";
                  list: "list";
                  grid: "grid";
                  timeline: "timeline";
                  graph: "graph";
                  kanban: "kanban";
                  gallery: "gallery";
                  gantt: "gantt";
                }>
              >;
              columns: z.ZodOptional<z.ZodArray<z.ZodAny>>;
              filters: z.ZodOptional<z.ZodArray<z.ZodAny>>;
              sorts: z.ZodOptional<z.ZodArray<z.ZodAny>>;
              groupByColumnId: z.ZodOptional<z.ZodString>;
              kanbanColumns: z.ZodOptional<
                z.ZodArray<
                  z.ZodObject<
                    {
                      id: z.ZodString;
                      value: z.ZodString;
                      label: z.ZodString;
                      order: z.ZodNumber;
                      color: z.ZodOptional<z.ZodString>;
                      limit: z.ZodOptional<z.ZodNumber>;
                    },
                    z.core.$strip
                  >
                >
              >;
              calendarDateField: z.ZodOptional<z.ZodString>;
              timelineTimeField: z.ZodOptional<z.ZodString>;
              graphLayout: z.ZodOptional<
                z.ZodEnum<{
                  force: "force";
                  hierarchical: "hierarchical";
                  circular: "circular";
                }>
              >;
              graphRelationshipTypes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            },
            z.core.$loose
          >
        >;
      },
      z.core.$loose
    >,
    z.ZodObject<
      {
        version: z.ZodLiteral<1>;
        category: z.ZodLiteral<"canvas">;
        elements: z.ZodArray<z.ZodUnknown>;
        embeddedEntities: z.ZodOptional<z.ZodArray<z.ZodString>>;
      },
      z.core.$strip
    >,
  ],
  "category"
>;
/**
 * Parse and validate view content
 * Throws ZodError if validation fails
 *
 * @param raw - Raw content to validate
 * @returns Validated view content
 */
export declare function parseViewContent(
  raw: unknown
): z.infer<typeof ViewContentSchema>;
/**
 * Safe parse view content
 * Returns success/error result without throwing
 *
 * @param raw - Raw content to validate
 * @returns Parse result with success flag and data/error
 */
export declare function safeParseViewContent(
  raw: unknown
): z.ZodSafeParseResult<
  | {
      [x: string]: unknown;
      version: 1;
      category: "structured";
      query: {
        profileIds?: string[] | undefined;
        profileSlugs?: string[] | undefined;
        entityTypes?: string[] | undefined;
        entityIds?: string[] | undefined;
        filters?:
          | {
              field: string;
              operator:
                | "in"
                | "equals"
                | "contains"
                | "gt"
                | "gte"
                | "lt"
                | "lte"
                | "notIn"
                | "between";
              value: unknown;
            }[]
          | undefined;
        sorts?:
          | {
              field: string;
              direction: "asc" | "desc";
            }[]
          | undefined;
        search?: string | undefined;
        limit?: number | undefined;
        offset?: number | undefined;
        groupBy?: string | undefined;
      };
      render?:
        | {
            [x: string]: unknown;
            layout?:
              | "table"
              | "calendar"
              | "list"
              | "grid"
              | "timeline"
              | "graph"
              | "kanban"
              | "gallery"
              | "gantt"
              | undefined;
            columns?: any[] | undefined;
            filters?: any[] | undefined;
            sorts?: any[] | undefined;
            groupByColumnId?: string | undefined;
            kanbanColumns?:
              | {
                  id: string;
                  value: string;
                  label: string;
                  order: number;
                  color?: string | undefined;
                  limit?: number | undefined;
                }[]
              | undefined;
            calendarDateField?: string | undefined;
            timelineTimeField?: string | undefined;
            graphLayout?: "force" | "hierarchical" | "circular" | undefined;
            graphRelationshipTypes?: string[] | undefined;
          }
        | undefined;
    }
  | {
      version: 1;
      category: "canvas";
      elements: unknown[];
      embeddedEntities?: string[] | undefined;
    }
>;
/**
 * Validate that content category matches view type
 *
 * @param viewType - The view type from database
 * @param content - The content to validate
 * @returns true if category matches, false otherwise
 */
export declare function validateContentCategoryForViewType(
  viewType: string,
  content: z.infer<typeof ViewContentSchema>
): boolean;
//# sourceMappingURL=schemas.d.ts.map
