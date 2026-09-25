/**
 * @synap-core/types/renderables — View Type Definitions
 *
 * Static capability manifest for every supported view type.
 * The `implemented` flag reflects what StructuredViewRenderer actually handles.
 * Update this file when adding new view types to the renderer.
 */

import type { ViewCapabilityDef } from "./types.js";

// ─── Structured views (entity query → render) ─────────────────────────────────

const sheetView: ViewCapabilityDef = {
  key: "sheet",
  aiHint:
    "Operational grid for editing many rows fast \u2014 the creation door that replaces Table.",
  name: "Sheet",
  description: "High-density, live entity grid for operating on connected data",
  icon: "Sheet",
  category: "structured",
  family: "collection",
  implemented: true,
  configSchema: [
    { key: "hiddenColumns", label: "Hidden columns", type: "string" },
    { key: "columnWidths", label: "Column widths", type: "object" },
    { key: "columnOrder", label: "Column order", type: "string" },
    { key: "frozenColumnIds", label: "Frozen columns", type: "string" },
    {
      key: "density",
      label: "Density",
      type: "select",
      defaultValue: "normal",
      options: [
        { value: "compact", label: "Compact" },
        { value: "normal", label: "Default" },
        { value: "spacious", label: "Comfortable" },
      ],
    },
    { key: "showRowNumbers", label: "Show row numbers", type: "boolean" },
  ],
};

const tableView: ViewCapabilityDef = {
  key: "table",
  aiHint: "Dense data, many columns, sort/filter heavy.",
  name: "Table",
  description: "Spreadsheet-style table with sortable, filterable columns",
  icon: "Table2",
  category: "structured",
  family: "collection",
  implemented: true,
  configSchema: [
    { key: "hiddenColumns", label: "Hidden columns", type: "string" },
    { key: "columnWidths", label: "Column widths", type: "object" },
    { key: "columnOrder", label: "Column order", type: "string" },
    { key: "pinnedColumns", label: "Pinned columns", type: "string" },
    {
      key: "rowHeight",
      label: "Row height",
      type: "select",
      defaultValue: "default",
      options: [
        { value: "compact", label: "Compact" },
        { value: "default", label: "Default" },
        { value: "comfortable", label: "Comfortable" },
      ],
    },
    {
      key: "stickyColumns",
      label: "Sticky column count",
      type: "number",
      defaultValue: 0,
    },
  ],
};

const listView: ViewCapabilityDef = {
  key: "list",
  aiHint: "Scan-friendly compact rows (tasks, notes).",
  name: "List",
  description: "Vertical list of entity cards with configurable fields",
  icon: "List",
  category: "structured",
  family: "collection",
  implemented: true,
  configSchema: [
    { key: "groupByField", label: "Group by property", type: "string" },
    { key: "cardFields", label: "Properties to show on cards", type: "string" },
  ],
};

const gridView: ViewCapabilityDef = {
  key: "grid",
  aiHint: "Card grid, medium density.",
  name: "Grid",
  description: "Card grid layout with uniform tiles",
  icon: "LayoutGrid",
  category: "structured",
  family: "collection",
  implemented: true,
  configSchema: [
    { key: "cardFields", label: "Properties to show", type: "string" },
    {
      key: "cardSize",
      label: "Card size",
      type: "select",
      defaultValue: "md",
      options: [
        { value: "sm", label: "Small" },
        { value: "md", label: "Medium" },
        { value: "lg", label: "Large" },
      ],
    },
  ],
};

const galleryView: ViewCapabilityDef = {
  key: "gallery",
  aiHint: "Image-forward cards (articles, bookmarks, products).",
  name: "Gallery",
  description:
    "Image-forward grid showing entity cover photos — books, movies, places",
  icon: "Images",
  category: "structured",
  family: "collection",
  implemented: true,
  requiredConfig: ["imageField"],
  configSchema: [
    {
      key: "imageField",
      label: "Image URL property",
      type: "string",
      required: true,
      description: "e.g. 'cover-url', 'poster'",
    },
    {
      key: "cardFields",
      label: "Properties to show below image",
      type: "string",
    },
  ],
};

const kanbanView: ViewCapabilityDef = {
  key: "kanban",
  aiHint: "Status pipelines (tasks by status, deals by stage).",
  name: "Kanban",
  description: "Drag-and-drop columns grouped by a status or category property",
  icon: "Columns",
  category: "structured",
  family: "grouped",
  implemented: true,
  requiredConfig: ["groupByField"],
  configSchema: [
    {
      key: "groupByField",
      label: "Group by property",
      type: "string",
      required: true,
      description: "e.g. 'status', 'stage'",
    },
    { key: "cardFields", label: "Properties on cards", type: "string" },
    {
      key: "cardSize",
      label: "Card size",
      type: "select",
      defaultValue: "md",
      options: [
        { value: "sm", label: "Small" },
        { value: "md", label: "Medium" },
        { value: "lg", label: "Large" },
      ],
    },
  ],
};

const matrixView: ViewCapabilityDef = {
  key: "matrix",
  aiHint: "2-axis grid (priority \u00d7 urgency, effort \u00d7 impact).",
  name: "Matrix",
  description:
    "2D grid with two properties as axes — entities appear as cards in intersecting cells. Ideal for priority×status, effort×impact, or any two-dimensional classification.",
  icon: "Grid3x3",
  category: "structured",
  family: "grouped",
  implemented: true,
  requiredConfig: ["xField", "yField"],
  configSchema: [
    {
      key: "xField",
      label: "Column axis property",
      type: "string",
      required: true,
      description: "Property for columns (X axis) — e.g. 'priority', 'effort'",
    },
    {
      key: "yField",
      label: "Row axis property",
      type: "string",
      required: true,
      description: "Property for rows (Y axis) — e.g. 'status', 'impact'",
    },
    { key: "cardFields", label: "Properties on cards", type: "string" },
    {
      key: "cardSize",
      label: "Card size",
      type: "select",
      defaultValue: "sm",
      options: [
        { value: "sm", label: "Small" },
        { value: "md", label: "Medium" },
        { value: "lg", label: "Large" },
      ],
    },
  ],
};

const masonryView: ViewCapabilityDef = {
  key: "masonry",
  aiHint: "Pinterest-style mixed-size cards; default for Library.",
  name: "Feed",
  description:
    "Pinterest-style masonry feed — all your captures, notes, and entities in one scrollable view. Cards size to their content.",
  icon: "LayoutGrid",
  category: "structured",
  family: "temporal",
  implemented: true,
  configSchema: [
    {
      key: "columnWidth",
      label: "Column width (px)",
      type: "number",
      defaultValue: 280,
      description: "Min width of each column",
    },
    {
      key: "sortField",
      label: "Sort by",
      type: "string",
      defaultValue: "createdAt",
    },
    {
      key: "sortDirection",
      label: "Sort direction",
      type: "select",
      defaultValue: "desc",
      options: [
        { value: "desc", label: "Newest first" },
        { value: "asc", label: "Oldest first" },
      ],
    },
  ],
};

const calendarView: ViewCapabilityDef = {
  key: "calendar",
  aiHint: "Date-indexed data (events, tasks by dueDate).",
  name: "Calendar",
  description:
    "Month and week calendar for date-bearing entities like events, tasks, releases",
  icon: "CalendarDays",
  category: "structured",
  family: "temporal",
  implemented: true,
  requiredConfig: ["dateField"],
  configSchema: [
    {
      key: "dateField",
      label: "Start date property",
      type: "string",
      required: true,
      defaultValue: "date",
    },
    { key: "endDateField", label: "End date property", type: "string" },
    { key: "colorField", label: "Color property", type: "string" },
  ],
};

const ganttView: ViewCapabilityDef = {
  key: "gantt",
  name: "Gantt",
  description:
    "Timeline bar chart for projects, milestones, and time-boxed work",
  icon: "GanttChart",
  category: "structured",
  family: "temporal",
  implemented: true,
  requiredConfig: ["dateField"],
  configSchema: [
    {
      key: "dateField",
      label: "Start date property",
      type: "string",
      required: true,
    },
    { key: "endDateField", label: "End date property", type: "string" },
    { key: "groupByField", label: "Group rows by", type: "string" },
  ],
};

const timelineView: ViewCapabilityDef = {
  key: "timeline",
  name: "Timeline",
  description:
    "Chronological event stream for history, milestones, or activity logs",
  icon: "GitCommitHorizontal",
  category: "structured",
  family: "temporal",
  implemented: true,
  requiredConfig: ["timeField"],
  configSchema: [
    {
      key: "timeField",
      label: "Time property",
      type: "string",
      required: true,
    },
    { key: "groupByField", label: "Group by property", type: "string" },
  ],
};

const graphView: ViewCapabilityDef = {
  key: "graph",
  name: "Galaxy",
  description:
    "Entity-kind galaxy for progressively exploring roles and relationships",
  icon: "Network",
  category: "structured",
  family: "relational",
  implemented: true,
  configSchema: [
    {
      key: "presentation",
      label: "Presentation",
      type: "select",
      defaultValue: "galaxy",
      options: [
        { value: "galaxy", label: "Galaxy" },
        { value: "network", label: "Network" },
      ],
    },
    {
      key: "layout",
      label: "Layout",
      type: "select",
      defaultValue: "kind",
      options: [
        { value: "kind", label: "By entity kind" },
        { value: "force", label: "Force-directed" },
        { value: "tree", label: "Tree" },
        { value: "radial", label: "Radial" },
      ],
    },
    {
      key: "showRelations",
      label: "Show relations",
      type: "boolean",
      defaultValue: true,
    },
  ],
};

const flowView: ViewCapabilityDef = {
  key: "flow",
  aiHint: "Node-edge diagrams (automations, process maps).",
  name: "Flow",
  description:
    "Directed graph / flowchart for processes, workflows, and agent orchestration",
  icon: "Workflow",
  category: "structured",
  family: "relational",
  implemented: true,
  configSchema: [
    {
      key: "layout",
      label: "Layout",
      type: "select",
      defaultValue: "dagre",
      options: [
        { value: "dagre", label: "Dagre (top-down)" },
        { value: "elk", label: "ELK (layered)" },
        { value: "force", label: "Force-directed" },
      ],
    },
  ],
};

const branchTreeView: ViewCapabilityDef = {
  key: "branch_tree",
  aiHint: "Conversation fork explorer \u2014 only meaningful inside a channel.",
  name: "Branch Tree",
  description: "AI conversation branch tree — visualize forked reasoning paths",
  icon: "GitBranch",
  category: "special",
  family: "relational",
  implemented: true,
  // Channel/conversation-specific fork explorer, not a lens on an entity query.
  entityLens: false,
  configSchema: [],
};

// ─── Canvas views (freeform, no entity query) ─────────────────────────────────

const bentoView: ViewCapabilityDef = {
  key: "bento",
  aiHint:
    "Mixed composition \u2014 a dashboard of cells (call synap_list_widgets for keys).",
  name: "Bento Dashboard",
  description:
    "Drag-and-drop grid dashboard composed of widgets — the home view type",
  icon: "LayoutDashboard",
  category: "special",
  family: "composite",
  implemented: true,
  // Freeform widget dashboard composed of many parts, not a single-query lens.
  entityLens: false,
  configSchema: [
    {
      key: "layout",
      label: "Layout mode",
      type: "select",
      defaultValue: "bento",
      options: [
        { value: "bento", label: "Bento grid" },
        { value: "grid", label: "Uniform grid" },
        { value: "flow", label: "Flow" },
      ],
    },
  ],
};

const whiteboardView: ViewCapabilityDef = {
  key: "whiteboard",
  aiHint: "Free-form canvas; seed its shapes at create.",
  name: "Whiteboard",
  description:
    "Freeform infinite canvas for diagrams, sketches, and brainstorming",
  icon: "PenTool",
  category: "canvas",
  family: "composite",
  implemented: true,
  // Freeform infinite canvas, not a lens on an entity query.
  entityLens: false,
  configSchema: [],
};

const mapView: ViewCapabilityDef = {
  key: "map",
  name: "Map",
  description:
    "Geographic map showing entity locations with optional route lines between them",
  icon: "MapPin",
  category: "structured",
  family: "spatial",
  implemented: true,
  configSchema: [
    { key: "locationField", label: "Location property", type: "string" },
    {
      key: "showRoutes",
      label: "Draw route between locations",
      type: "boolean",
    },
  ],
};

const mindmapView: ViewCapabilityDef = {
  key: "mindmap",
  name: "Mind Map",
  description:
    "Hierarchical mind map for outlining, planning, and concept mapping",
  icon: "BrainCircuit",
  category: "canvas",
  family: "relational",
  implemented: false,
  // Freeform outline canvas, not a lens on an entity query.
  entityLens: false,
  configSchema: [],
};

// ─── Exports ──────────────────────────────────────────────────────────────────

export const VIEW_DEFINITIONS: ViewCapabilityDef[] = [
  // Structured
  sheetView,
  tableView,
  listView,
  gridView,
  galleryView,
  kanbanView,
  matrixView,
  masonryView,
  calendarView,
  ganttView,
  timelineView,
  graphView,
  flowView,
  mapView,
  branchTreeView,
  // Special
  bentoView,
  // Canvas
  whiteboardView,
  mindmapView,
];

/** Fast lookup map: viewType → definition */
export const VIEW_BY_KEY: Record<string, ViewCapabilityDef> =
  Object.fromEntries(VIEW_DEFINITIONS.map((d) => [d.key, d]));

/** View types that StructuredViewRenderer can currently render. */
export const IMPLEMENTED_VIEW_TYPES = VIEW_DEFINITIONS.filter(
  (d) => d.implemented
).map((d) => d.key);

/**
 * The one catalogue for user-created views. It deliberately excludes the
 * legacy Table creator (Sheet is the operational successor) and Branch Tree,
 * which only has meaning inside a conversation. Existing saved instances of
 * both remain fully renderable.
 */
export const CREATABLE_VIEW_DEFINITIONS = VIEW_DEFINITIONS.filter(
  (definition) =>
    definition.implemented &&
    definition.key !== "table" &&
    definition.key !== "branch_tree"
);

/** Structured view types (use entity query + render config). */
export const STRUCTURED_VIEW_TYPES = VIEW_DEFINITIONS.filter(
  (d) => d.category === "structured"
).map((d) => d.key);
