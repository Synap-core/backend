/**
 * @synap-core/types/renderables — Widget Definitions
 *
 * Static capability manifest for every registered bento widget type.
 * Mirrors the registrations in registerBentoCells() + registerCoreDomainCells().
 * Update this file whenever a new widget is registered.
 */

import type {
  CellSettingsField,
  RenderableDataBinding,
  WidgetCapabilityDef,
  WidgetTypeKey,
} from "./types.js";
import {
  CHART_DATA_SHAPE_BY_KEY,
  CHART_DATA_SHAPE_HINTS,
  chartDataJsonSchema,
  type ChartCellKey,
} from "./chart-data.js";

// Data bindings (decision D2). Declare only what the cell's component renders
// TODAY. Charts draw through `useChartSeries` (@synap-core/hooks), which reads
// EITHER the live query OR a snapshot `props.data` of the declared `dataShape`;
// so a chart supports both, and a NEW embed defaults to the snapshot (it then
// matches the sentence written about it). Dashboards stay live because the
// bento picker never writes `data`.
const QUERY_BINDING: RenderableDataBinding = {
  supports: ["query"],
  default: "query",
};
function snapshotBinding(key: ChartCellKey): RenderableDataBinding {
  return {
    supports: ["inline", "query"],
    default: "inline",
    dataShape: CHART_DATA_SHAPE_BY_KEY[key],
  };
}

/**
 * A snapshot-capable entry declares its `data` + `capturedAt` props — DERIVED
 * from the binding, so a chart that gains `inline` cannot forget them. Hidden
 * from the settings panel: "Freeze" (or the author's markdown) writes them.
 */
function withSnapshotFields(def: WidgetCapabilityDef): WidgetCapabilityDef {
  const shape = def.dataBinding?.dataShape;
  if (!shape || !def.dataBinding?.supports.includes("inline")) return def;
  const fields: CellSettingsField[] = [
    {
      key: "data",
      label: "Snapshot data",
      type: "object",
      settingsHidden: true,
      description: `Frozen data (${CHART_DATA_SHAPE_HINTS[shape]}). Present = snapshot; absent = live query.`,
      jsonSchema: chartDataJsonSchema(shape),
    },
    {
      key: "capturedAt",
      label: "Captured at",
      type: "date",
      settingsHidden: true,
      description:
        'ISO date the snapshot data was taken (shown as "Snapshot · <date>").',
    },
  ];
  return { ...def, configSchema: [...def.configSchema, ...fields] };
}
const INLINE_BINDING: RenderableDataBinding = {
  supports: ["inline"],
  default: "inline",
};
const NO_BINDING: RenderableDataBinding = {
  supports: ["none"],
  default: "none",
};

// ─── Core / Workspace ─────────────────────────────────────────────────────────

// welcome + welcomeHeader removed — superseded by the `greeting` cell below.

const greeting: WidgetCapabilityDef = {
  key: "greeting",
  package: "synap.bento-widgets",
  requiredConfig: [],
  aiHint:
    "Home hero row: time-of-day greeting and today's date. No config needed.",
  dataBinding: NO_BINDING,
  name: "Greeting",
  description:
    "Time-of-day greeting with the user's name, today's date, and an optional 'N captured today' count. The home dashboard's hero block — fully editable like any other cell.",
  icon: "Sparkles",
  category: "core",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 8, h: 2 },
  configSchema: [
    {
      key: "showDate",
      label: "Show today's date",
      type: "boolean",
      defaultValue: true,
    },
    {
      key: "showCapturedToday",
      label: "Show 'N captured today'",
      type: "boolean",
      defaultValue: true,
    },
    {
      key: "name",
      label: "Name override",
      type: "string",
      description: "Leave blank to use your account name",
    },
  ],
};

const sectionHeader: WidgetCapabilityDef = {
  key: "section-header",
  package: "synap.core-widgets",
  requiredConfig: ["title"],
  aiHint:
    "Title row for a group of cells. config.title; optional icon, color; profileSlug + showCount adds a count badge.",
  dataBinding: NO_BINDING,
  name: "Section Header",
  description: "Titled section divider with optional icon and entity count",
  icon: "Heading",
  category: "core",
  semanticSection: "layout-compose",
  directAdd: true,
  displayModes: ["compact"],
  defaultSize: { w: 12, h: 2 },
  configSchema: [
    { key: "title", label: "Title", type: "string", required: true },
    {
      key: "icon",
      label: "Icon",
      type: "icon",
      description: "e.g. 'BookOpen'",
    },
    { key: "profileSlug", label: "Profile (for count)", type: "profile" },
    {
      key: "showCount",
      label: "Show count",
      type: "boolean",
      defaultValue: false,
    },
    { key: "color", label: "Accent color", type: "color" },
  ],
};

const workspaceInfo: WidgetCapabilityDef = {
  key: "workspace-info",
  package: "synap.bento-widgets",
  name: "Workspace Info",
  description: "Current workspace name, connection status, and member count",
  icon: "Database",
  category: "core",
  semanticSection: "layout-compose",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 2 },
  // Kept pickable (a sensible core widget with no sensible generic to fold into).
  // The former `showMemberCount` / `showConnectionStatus` flags were phantom —
  // the cell ignores config — so the schema is empty: the settings panel now
  // honestly shows "no settings" instead of dead toggles.
  configSchema: [],
};

const homeTabs: WidgetCapabilityDef = {
  key: "home-tabs",
  package: "synap.bento-widgets",
  name: "Home Tabs",
  description: "Navigation tabs to switch between workspace and personal home",
  icon: "LayoutGrid",
  category: "core",
  displayModes: ["compact"],
  defaultSize: { w: 4, h: 2 },
  // App chrome, not a user-addable block — it wires ephemeral navigation
  // callbacks supplied by the host shell, so it can't be meaningfully placed
  // from the picker. Hidden; key + cell stay registered for any existing block.
  hiddenFromPicker: true,
  configSchema: [],
};

const calendarWidget: WidgetCapabilityDef = {
  key: "calendar",
  package: "synap.bento-widgets",
  requiredConfig: [],
  aiHint:
    "Key is `calendar`, not calendar-widget. Optional profileSlug + dateField to plot entities.",
  dataBinding: QUERY_BINDING,
  name: "Calendar",
  description: "Month/week calendar view of events or date-bearing entities",
  icon: "Calendar",
  category: "data",
  semanticSection: "browse-explore",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 8, h: 8 },
  configSchema: [
    {
      key: "defaultView",
      label: "Default view",
      type: "variant",
      defaultValue: "dayGridMonth",
      options: [
        { value: "dayGridMonth", label: "Month" },
        { value: "timeGridWeek", label: "Week" },
        { value: "timeGridDay", label: "Day" },
        { value: "listWeek", label: "Agenda" },
      ],
    },
    {
      key: "profileSlug",
      label: "Profile slug",
      type: "profile",
      description: "Entity type to show, e.g. 'event'",
    },
    {
      key: "dateField",
      label: "Date field",
      type: "property",
      dependsOn: "profileSlug",
      defaultValue: "date",
    },
    {
      key: "endDateField",
      label: "End date field",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "titleField",
      label: "Title field",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "colorField",
      label: "Color field",
      type: "property",
      dependsOn: "profileSlug",
    },
  ],
};

// ─── Data / Entity ────────────────────────────────────────────────────────────

const entityList: WidgetCapabilityDef = {
  key: "entity-list",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "Scrollable list for a profile \u2014 use it when you have a profileSlug but no saved view UUID. Optional limit, filter, sortField.",
  dataBinding: QUERY_BINDING,
  name: "Entity List",
  description:
    "Scrollable list of entities, optionally filtered by type or property",
  icon: "List",
  category: "data",
  semanticSection: "browse-explore",
  requiresSetup: true,
  displayModes: ["compact", "medium"],
  defaultSize: { w: 4, h: 6 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile slug",
      type: "profile",
      description: "Entity type to list, e.g. 'task'",
    },
    { key: "title", label: "Widget title", type: "string" },
    { key: "limit", label: "Max items", type: "number", defaultValue: 10 },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
      description: "Conditions to filter the listed entities by",
    },
    {
      key: "sortField",
      label: "Sort field",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "sortDirection",
      label: "Sort direction",
      type: "select",
      options: [
        { value: "asc", label: "Ascending" },
        { value: "desc", label: "Descending" },
      ],
      defaultValue: "desc",
    },
    { key: "color", label: "Accent color", type: "color" },
  ],
  presets: [
    {
      label: "Recent Tasks",
      icon: "CheckSquare",
      config: {
        profileSlug: "task",
        title: "Tasks",
        sortField: "createdAt",
        sortDirection: "desc",
      },
    },
    {
      label: "My Contacts",
      icon: "Users",
      config: { profileSlug: "contact", title: "Contacts" },
    },
    {
      label: "Active Deals",
      icon: "TrendingUp",
      config: { profileSlug: "deal", title: "Deals" },
    },
  ],
};

const entityCard: WidgetCapabilityDef = {
  key: "entity-card",
  package: "synap.bento-widgets",
  requiredConfig: ["entityId"],
  aiHint:
    "ONE entity: config.entityId must be a real entity UUID, not a profile slug.",
  dataBinding: QUERY_BINDING,
  name: "Entity Card",
  description: "Single entity displayed as a compact card with key properties",
  icon: "FileText",
  category: "data",
  semanticSection: "browse-explore",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 4 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile slug (pick latest)",
      type: "profile",
    },
    {
      key: "entityId",
      label: "Entity ID (pin specific entity)",
      type: "entity",
      dependsOn: "profileSlug",
    },
    {
      key: "showFields",
      label: "Properties to display",
      type: "array",
      itemType: "property",
      dependsOn: "profileSlug",
    },
  ],
};

const entityHeader: WidgetCapabilityDef = {
  key: "entity-header",
  package: "synap.bento-widgets",
  name: "Entity Header",
  description:
    "Shows the entity title, type, and status in the bento. Optional — on entity dashboards the host often already shows this context; use when you want a dedicated hero block or a different layout.",
  icon: "Heading",
  category: "entity",
  displayModes: ["compact"],
  defaultSize: { w: 12, h: 2 },
  // Demoted to an Entity Properties preset ("Entity Header"). Hidden from the
  // picker; key + cell stay registered so existing blocks keep rendering.
  hiddenFromPicker: true,
  configSchema: [],
};

const entityProperties: WidgetCapabilityDef = {
  key: "entity-properties",
  package: "synap.bento-widgets",
  name: "Entity Properties",
  description:
    "Display entity properties. mode='all' shows all properties, mode='single' shows one property (like property-value), mode='group' shows a named subset (like property-group).",
  icon: "FileText",
  category: "entity",
  semanticSection: "layout-compose",
  requiresSetup: true,
  displayModes: ["compact", "medium"],
  defaultSize: { w: 4, h: 6 },
  configSchema: [
    {
      key: "mode",
      label: "Mode",
      type: "variant",
      defaultValue: "all",
      options: [
        { value: "all", label: "All properties" },
        { value: "single", label: "Single property" },
        { value: "group", label: "Property group" },
      ],
      description:
        "all = show all, single = one property (set propertyKey), group = named subset (set properties array)",
    },
    {
      key: "profileSlug",
      label: "Profile",
      type: "profile",
      description:
        "Entity type to scope the property pickers. On entity dashboards this is auto-detected from the host entity.",
    },
    {
      key: "propertyKey",
      label: "Property (single mode)",
      type: "property",
      dependsOn: "profileSlug",
      description:
        "Used when mode='single' — picked from the profile's properties",
    },
    {
      key: "properties",
      label: "Property slugs (group mode)",
      type: "array",
      itemType: "property",
      dependsOn: "profileSlug",
      description:
        "Used when mode='group'. Ordered list of property slugs, picked from the scoped profile's properties.",
    },
    {
      key: "title",
      label: "Group title",
      type: "string",
      description: "Card title for group mode",
    },
  ],
  presets: [
    {
      // Replaces the former dedicated `entity-header` widget (now hidden).
      // A group of the identity properties — title, type, status.
      label: "Entity Header",
      icon: "Heading",
      config: { mode: "group", properties: ["title", "type", "status"] },
    },
  ],
};

const entityLinks: WidgetCapabilityDef = {
  key: "entity-links",
  package: "synap.bento-widgets",
  name: "Entity Links",
  description:
    "List of related entities linked to this entity (from the relation graph), optionally filtered by target type (e.g. only tasks, only notes). Use for 'tasks for this deal', 'notes for this contact'. You can filter by relationship type (e.g. subtask).",
  icon: "Link",
  category: "entity",
  semanticSection: "layout-compose",
  requiresSetup: true,
  displayModes: ["compact", "medium"],
  defaultSize: { w: 6, h: 6 },
  configSchema: [
    {
      key: "_parentProfileSlug",
      label: "Parent type",
      type: "profile",
      description:
        "Type of the parent entity (auto-detected from the host entity on entity dashboards).",
    },
    {
      key: "entityId",
      label: "Parent entity",
      type: "entity",
      dependsOn: "_parentProfileSlug",
      description: "Which entity's linked items to show.",
    },
    {
      key: "profileSlug",
      label: "Related type filter",
      type: "profile",
      description:
        "Only show linked entities of this type (e.g. tasks, notes).",
    },
    {
      key: "relationshipType",
      label: "Relationship type",
      type: "relation-type",
      description: "Only show links of this relationship (e.g. subtask).",
    },
    {
      key: "variant",
      label: "Layout",
      type: "variant",
      defaultValue: "list",
      options: [
        { value: "list", label: "List" },
        { value: "board", label: "Board" },
      ],
    },
    { key: "title", label: "Section title", type: "string" },
    { key: "limit", label: "Max items", type: "number", defaultValue: 10 },
  ],
  presets: [
    {
      // Replaces the former dedicated `entity-relationships` widget (now hidden).
      // No profile/relationship filter → every linked entity regardless of type,
      // i.e. the "all relation rows" experience entity-relationships gave. The
      // relationshipType field above still narrows it to one link type when set.
      label: "All Relationships",
      icon: "Share2",
      config: { title: "Relationships" },
    },
    {
      label: "Linked Notes",
      icon: "FileText",
      config: { profileSlug: "note", title: "Notes" },
    },
    {
      label: "Linked Tasks",
      icon: "CheckSquare",
      config: { profileSlug: "task", title: "Tasks" },
    },
    {
      label: "Files",
      icon: "File",
      config: { profileSlug: "file", title: "Files" },
    },
  ],
};

const entitySpotlight: WidgetCapabilityDef = {
  key: "entity-spotlight",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "Features one entity picked from a profile: config.profileSlug (optional seed, layout).",
  dataBinding: QUERY_BINDING,
  name: "Entity Spotlight",
  description:
    "Highlight one entity prominently — daily pick, random, or pinned",
  icon: "Star",
  category: "data",
  semanticSection: "browse-explore",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 4 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile slug",
      type: "profile",
      required: true,
    },
    {
      key: "seed",
      label: "Pick mode",
      type: "variant",
      defaultValue: "daily",
      options: [
        { value: "daily", label: "Daily pick" },
        { value: "random", label: "Random (with refresh)" },
        { value: "pinned", label: "Pinned" },
      ],
    },
    {
      key: "layout",
      label: "Layout",
      type: "variant",
      defaultValue: "detail",
      options: [
        { value: "detail", label: "Detail (title + props)" },
        { value: "compact", label: "Compact (title only)" },
        { value: "quote", label: "Quote (pull-quote + attribution)" },
      ],
    },
    {
      key: "titleField",
      label: "Title property",
      type: "property",
      dependsOn: "profileSlug",
      description: "Falls back to entity.title",
    },
    {
      key: "subtitleField",
      label: "Subtitle property",
      type: "property",
      dependsOn: "profileSlug",
      description: "e.g. 'author'",
    },
    { key: "color", label: "Accent color", type: "color" },
  ],
  presets: [
    {
      label: "Daily Quote",
      icon: "Quote",
      config: {
        layout: "quote",
        profileSlug: "bookmark",
        titleField: "content",
        subtitleField: "author",
        label: "Daily Quote",
      },
    },
    {
      label: "Random Note",
      icon: "FileText",
      config: {
        profileSlug: "note",
        titleField: "content",
        label: "Highlights",
      },
    },
  ],
};

const entityGallery: WidgetCapabilityDef = {
  key: "entity-gallery",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "Card grid of a profile's entities: config.profileSlug. Optional limit, coverField.",
  dataBinding: QUERY_BINDING,
  name: "Entity Gallery",
  description:
    "Grid of entities with cover images — books, articles, places, movies",
  icon: "LayoutGrid",
  category: "data",
  semanticSection: "browse-explore",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 8, h: 4 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile slug",
      type: "profile",
      required: true,
    },
    {
      key: "coverField",
      label: "Cover image property",
      type: "property",
      dependsOn: "profileSlug",
      defaultValue: "cover-url",
    },
    { key: "title", label: "Widget title", type: "string" },
    { key: "limit", label: "Max items", type: "number", defaultValue: 8 },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    { key: "color", label: "Accent color", type: "color" },
  ],
};

// ─── Metrics ──────────────────────────────────────────────────────────────────

const statCard: WidgetCapabilityDef = {
  key: "stat-card",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "One metric over a profile: config.profileSlug. aggregation defaults to count. Optional label, icon, color, chartType. Counts use stat-card, not entity-count.",
  dataBinding: QUERY_BINDING,
  name: "Stat Card",
  description:
    "Single metric (count, sum, average, min, max) or distribution (pie/bar by status, type, etc.). Use metric for KPIs; use distribution to show breakdown by a property.",
  icon: "TrendingUp",
  category: "data",
  semanticSection: "track-monitor",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 3, h: 3 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile",
      type: "profile",
      required: true,
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      key: "chartType",
      label: "Chart",
      type: "variant",
      defaultValue: "none",
      description:
        "For donut/bar: pick a 'Group by' field first. For sparkline/area: picks from time trend.",
      options: [
        { value: "none", label: "Number only" },
        { value: "sparkline", label: "Sparkline" },
        { value: "bar", label: "Bar chart" },
        { value: "area", label: "Area chart" },
        { value: "donut", label: "Donut" },
      ],
    },
    {
      key: "field",
      label: "Property (for sum/avg/min/max)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    { key: "label", label: "Display label", type: "string" },
    { key: "color", label: "Accent color", type: "color" },
    { key: "icon", label: "Icon", type: "icon" },
    {
      key: "prefix",
      label: "Value prefix",
      type: "string",
      description: "e.g. $",
    },
    {
      key: "suffix",
      label: "Value suffix",
      type: "string",
      description: "e.g. %",
    },
    {
      key: "timePeriod",
      label: "Time period",
      type: "select",
      defaultValue: "week",
      description: "Granularity for trend charts",
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
        { value: "quarter", label: "Quarterly" },
      ],
    },
  ],
  presets: [
    {
      label: "Task Progress",
      icon: "CheckCircle2",
      config: {
        aggregation: "completion",
        profileSlug: "task",
        chartType: "progress",
        label: "Task Progress",
        suffix: "%",
      },
    },
    {
      label: "Entity Count",
      icon: "Hash",
      config: { aggregation: "count", label: "Total" },
    },
    {
      label: "Revenue",
      icon: "DollarSign",
      config: {
        aggregation: "sum",
        field: "value",
        profileSlug: "deal",
        prefix: "$",
        label: "Revenue",
      },
    },
    {
      // Replaces the former dedicated `reading-progress` widget (now hidden).
      // Completion % of books in the "reading" status, rendered as a progress bar.
      label: "Reading Progress",
      icon: "BookOpen",
      config: {
        aggregation: "completion",
        profileSlug: "book",
        chartType: "progress",
        completionStatusField: "status",
        completionDoneValues: "read,finished,completed",
        label: "Currently Reading",
        suffix: "%",
      },
    },
  ],
};

// ─── Charts (charts-as-cells) ─────────────────────────────────────────────────

const chartLine: WidgetCapabilityDef = {
  key: "chart-line",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "Trend over time for a profile: aggregation + valueField + timePeriod.",
  dataBinding: snapshotBinding("chart-line"),
  name: "Line Chart",
  description:
    "Time-series line chart of entities over time. Buckets by creation date and plots a count or a numeric aggregation (sum/avg/min/max) of a property per bucket.",
  icon: "LineChart",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile",
      type: "profile",
      required: true,
    },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      key: "valueField",
      label: "Property (for sum/avg/min/max)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "timePeriod",
      label: "Time period",
      type: "select",
      defaultValue: "week",
      description: "Granularity of the x-axis buckets",
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
      ],
    },
    { key: "color", label: "Line color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Entities over time",
      icon: "TrendingUp",
      config: {
        aggregation: "count",
        timePeriod: "week",
        label: "Created over time",
      },
    },
  ],
};

const chartArea: WidgetCapabilityDef = {
  key: "chart-area",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "Filled trend over time for a profile: aggregation + valueField + timePeriod.",
  dataBinding: snapshotBinding("chart-area"),
  name: "Area Chart",
  description:
    "Time-series area chart of entities over time. Buckets by creation date and plots a count or a numeric aggregation (sum/avg/min/max) of a property per bucket, filled to the axis.",
  icon: "AreaChart",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      key: "valueField",
      label: "Property (for sum/avg/min/max)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "timePeriod",
      label: "Time period",
      type: "select",
      defaultValue: "week",
      description: "Granularity of the x-axis buckets",
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
      ],
    },
    { key: "color", label: "Area color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Entities over time",
      icon: "TrendingUp",
      config: {
        aggregation: "count",
        timePeriod: "week",
        label: "Created over time",
      },
    },
  ],
};

const chartBar: WidgetCapabilityDef = {
  key: "chart-bar",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    'Category mode (default) counts per config.groupBy value (e.g. status) \u2014 set groupBy; mode:"trend" bars an aggregate per time bucket.',
  dataBinding: snapshotBinding("chart-bar"),
  name: "Bar Chart",
  description:
    "Bar chart of entities. In category mode (default) it counts entities per distinct value of a group-by property (e.g. status, priority). In trend mode it buckets by creation date and bars the aggregated value per time bucket.",
  icon: "BarChart3",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "mode",
      label: "Mode",
      type: "variant",
      defaultValue: "category",
      options: [
        { value: "category", label: "Category (group by)" },
        { value: "trend", label: "Trend (over time)" },
      ],
      description:
        "category = count per group-by value; trend = aggregated value per time bucket",
    },
    {
      key: "groupBy",
      label: "Group by property (category mode)",
      type: "property",
      dependsOn: "profileSlug",
      description: "Property whose values become the bars (e.g. status)",
    },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "aggregation",
      label: "Aggregation (trend mode)",
      type: "select",
      defaultValue: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      key: "valueField",
      label: "Property (trend sum/avg/min/max)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "timePeriod",
      label: "Time period (trend mode)",
      type: "select",
      defaultValue: "week",
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
      ],
    },
    { key: "color", label: "Bar color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Status breakdown",
      icon: "BarChart3",
      config: { mode: "category", groupBy: "status", label: "By status" },
    },
  ],
};

const chartPie: WidgetCapabilityDef = {
  key: "chart-pie",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug", "groupBy"],
  aiHint: "Share of a profile by config.groupBy (e.g. status).",
  dataBinding: snapshotBinding("chart-pie"),
  name: "Pie Chart",
  description:
    "Donut/pie chart showing the distribution of entities across the distinct values of a group-by property (e.g. status, priority, type). Each slice is a category, sized by entity count.",
  icon: "PieChart",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 5, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "groupBy",
      label: "Group by property",
      type: "property",
      dependsOn: "profileSlug",
      required: true,
      description: "Property whose values become the slices (e.g. status)",
    },
    { key: "color", label: "Accent color (header)", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Status breakdown",
      icon: "PieChart",
      config: { groupBy: "status", label: "By status" },
    },
  ],
};

const chartGauge: WidgetCapabilityDef = {
  key: "chart-gauge",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint: "One aggregate against a max: aggregation + valueField + max.",
  dataBinding: snapshotBinding("chart-gauge"),
  name: "Gauge Chart",
  description:
    "Radial gauge for a single 0–100 metric. Use 'completion' to show the % of entities in a done state, or count/sum/avg normalized against a max ceiling.",
  icon: "Gauge",
  category: "charts",
  semanticSection: "track-monitor",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 4 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "completion",
      options: [
        { value: "completion", label: "Completion %" },
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
      ],
    },
    {
      key: "valueField",
      label: "Property (for sum/avg)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "max",
      label: "Max (for count/sum/avg)",
      type: "number",
      description:
        "Ceiling the value is mapped to 100% against (ignored for completion)",
    },
    { key: "color", label: "Arc color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Task completion",
      icon: "CheckCircle2",
      config: {
        aggregation: "completion",
        profileSlug: "task",
        label: "Completion",
      },
    },
  ],
};

const chartRing: WidgetCapabilityDef = {
  key: "chart-ring",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint: "One aggregate as a progress ring: aggregation + valueField + max.",
  dataBinding: snapshotBinding("chart-ring"),
  name: "Ring Chart",
  description:
    "Full-circle progress ring for a single 0–100 metric. Use 'completion' to show the % of entities in a done state, or count/sum/avg normalized against a max ceiling. Distinct from the gauge (a 270° arc): the ring is a complete donut-progress circle.",
  icon: "CircleDot",
  category: "charts",
  semanticSection: "track-monitor",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 4 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "completion",
      options: [
        { value: "completion", label: "Completion %" },
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
      ],
    },
    {
      key: "valueField",
      label: "Property (for sum/avg)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "max",
      label: "Max (for count/sum/avg)",
      type: "number",
      description:
        "Ceiling the value is mapped to 100% against (ignored for completion)",
    },
    { key: "color", label: "Ring color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Task completion",
      icon: "CheckCircle2",
      config: {
        aggregation: "completion",
        profileSlug: "task",
        label: "Completion",
      },
    },
  ],
};

const chartRadar: WidgetCapabilityDef = {
  key: "chart-radar",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug", "metrics"],
  aiHint: "Several metrics compared: config.metrics lists the properties.",
  dataBinding: snapshotBinding("chart-radar"),
  name: "Radar Chart",
  description:
    "Radar/spider chart comparing several numeric properties on a shared scale. Each metric becomes an axis; the value is that property aggregated across the matched entities (sum/avg/min/max, or a non-null count).",
  icon: "Radar",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 5, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "metrics",
      label: "Metrics (≥3 properties)",
      type: "array",
      itemType: "property",
      dependsOn: "profileSlug",
      required: true,
      description: "Numeric properties — one spoke each (at least three)",
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "avg",
      options: [
        { value: "avg", label: "Average" },
        { value: "sum", label: "Sum" },
        { value: "count", label: "Count" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    { key: "color", label: "Series color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
};

const chartScatter: WidgetCapabilityDef = {
  key: "chart-scatter",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug", "xField", "yField"],
  aiHint: "Two numeric properties plotted: config.xField + config.yField.",
  dataBinding: snapshotBinding("chart-scatter"),
  name: "Scatter Plot",
  description:
    "Scatter plot of entities across two numeric properties. Each entity is a dot positioned at (xField, yField); use it to spot correlations between two metrics.",
  icon: "ScatterChart",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "xField",
      label: "X axis property",
      type: "property",
      dependsOn: "profileSlug",
      required: true,
      description: "Numeric property mapped to the x axis",
    },
    {
      key: "yField",
      label: "Y axis property",
      type: "property",
      dependsOn: "profileSlug",
      required: true,
      description: "Numeric property mapped to the y axis",
    },
    { key: "color", label: "Dot color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
};

const chartFunnel: WidgetCapabilityDef = {
  key: "chart-funnel",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug", "stageField"],
  aiHint: "Counts per stage in order: config.stageField.",
  dataBinding: snapshotBinding("chart-funnel"),
  name: "Funnel Chart",
  description:
    "Funnel chart of ordered, decreasing stages. Counts entities per distinct value of a stage property and draws centered trapezoid rows (widest first); each stage shows its % of the first (top) stage.",
  icon: "Filter",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 5, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "stageField",
      label: "Stage property",
      type: "property",
      dependsOn: "profileSlug",
      required: true,
      description:
        "Property whose values become the funnel stages (e.g. dealStage)",
    },
    { key: "color", label: "Funnel color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Deal pipeline",
      icon: "Filter",
      config: {
        stageField: "commercialStage",
        profileSlug: "deal",
        label: "Pipeline",
      },
    },
  ],
};

const chartComposed: WidgetCapabilityDef = {
  key: "chart-composed",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "Bars and a line on one time axis: barAggregation/barField + lineAggregation/lineField.",
  dataBinding: snapshotBinding("chart-composed"),
  name: "Composed Chart",
  description:
    "Dual-axis chart over a shared time axis: a bar series (left axis) plus a line series (right axis). Buckets entities by creation date and runs an independent aggregation per series — use it to overlay a volume (bars) against a rate or running metric (line).",
  icon: "BarChart3",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "barAggregation",
      label: "Bar aggregation",
      type: "select",
      defaultValue: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      key: "barField",
      label: "Bar property (for sum/avg/min/max)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "lineAggregation",
      label: "Line aggregation",
      type: "select",
      defaultValue: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      key: "lineField",
      label: "Line property (for sum/avg/min/max)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "timePeriod",
      label: "Time period",
      type: "select",
      defaultValue: "week",
      description: "Granularity of the x-axis buckets",
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
      ],
    },
    { key: "barColor", label: "Bar color", type: "color" },
    { key: "lineColor", label: "Line color", type: "color" },
    { key: "barLabel", label: "Bar legend label", type: "string" },
    { key: "lineLabel", label: "Line legend label", type: "string" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Volume vs running total",
      icon: "TrendingUp",
      config: {
        barAggregation: "count",
        lineAggregation: "count",
        timePeriod: "week",
        barLabel: "Created",
        lineLabel: "Activity",
        label: "Volume vs activity",
      },
    },
  ],
};

const chartLiveLine: WidgetCapabilityDef = {
  key: "chart-live-line",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "Auto-refreshing trend: valueField + aggregation; optional refreshSeconds.",
  // Live by nature (it polls): a frozen live-line would be a plain line chart.
  dataBinding: {
    ...QUERY_BINDING,
    dataShape: CHART_DATA_SHAPE_BY_KEY["chart-live-line"],
  },
  name: "Live Line Chart",
  description:
    "Self-refreshing time-series line chart. Same buckets-over-time render as the line chart, but the data polls on an interval (refreshSeconds, default 30s) and shows an animated 'live' pulse — use for dashboards that should stay current.",
  icon: "Activity",
  category: "charts",
  semanticSection: "track-monitor",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "valueField",
      label: "Property (for sum/avg/min/max)",
      type: "property",
      dependsOn: "profileSlug",
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      key: "timePeriod",
      label: "Time period",
      type: "select",
      defaultValue: "week",
      description: "Granularity of the x-axis buckets",
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
      ],
    },
    {
      key: "refreshSeconds",
      label: "Refresh interval (seconds)",
      type: "number",
      defaultValue: 30,
      description: "How often the chart re-queries (minimum 5s)",
    },
    { key: "color", label: "Line color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Live activity",
      icon: "Activity",
      config: {
        aggregation: "count",
        timePeriod: "day",
        refreshSeconds: 30,
        label: "Live activity",
      },
    },
  ],
};

const chartProfitLoss: WidgetCapabilityDef = {
  key: "chart-profit-loss",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint: "Positive/negative bars around a baseline: valueField + aggregation.",
  dataBinding: snapshotBinding("chart-profit-loss"),
  name: "Profit / Loss Chart",
  description:
    "Time-series line with diverging fill around a baseline (default 0). Buckets a signed value property by creation date; segments above the baseline read positive (success), below read negative (error). Use for revenue-minus-cost, net change, or any signed metric over time.",
  icon: "TrendingUp",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "valueField",
      label: "Signed value property",
      type: "property",
      dependsOn: "profileSlug",
      description: "Numeric property (can be negative) aggregated per bucket",
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "sum",
      options: [
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
        { value: "count", label: "Count" },
        { value: "min", label: "Min" },
        { value: "max", label: "Max" },
      ],
    },
    {
      key: "timePeriod",
      label: "Time period",
      type: "select",
      defaultValue: "week",
      description: "Granularity of the x-axis buckets",
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
      ],
    },
    {
      key: "baseline",
      label: "Baseline",
      type: "number",
      defaultValue: 0,
      description: "The zero line the fill diverges around",
    },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Net revenue over time",
      icon: "TrendingUp",
      config: {
        aggregation: "sum",
        timePeriod: "month",
        baseline: 0,
        label: "Net revenue",
      },
    },
  ],
};

const chartSankey: WidgetCapabilityDef = {
  key: "chart-sankey",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug", "sourceField", "targetField"],
  aiHint:
    "Flows between two properties: config.sourceField + config.targetField.",
  dataBinding: snapshotBinding("chart-sankey"),
  name: "Sankey Chart",
  description:
    "Flow diagram of entities moving from a source category to a target category. Counts entities per distinct source→target pair and draws proportional flows between node columns — use to visualize transitions (e.g. lead source → deal stage, channel → status).",
  icon: "Spline",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "sourceField",
      label: "Source property",
      type: "property",
      dependsOn: "profileSlug",
      required: true,
      description: "Property whose values become the left (source) nodes",
    },
    {
      key: "targetField",
      label: "Target property",
      type: "property",
      dependsOn: "profileSlug",
      required: true,
      description: "Property whose values become the right (target) nodes",
    },
    { key: "color", label: "Accent color (header)", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Lead source → stage",
      icon: "Spline",
      config: {
        sourceField: "source",
        targetField: "commercialStage",
        profileSlug: "deal",
        label: "Source to stage",
      },
    },
  ],
};

const chartChoropleth: WidgetCapabilityDef = {
  key: "chart-choropleth",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug", "regionField"],
  aiHint:
    "Values per region on a map: config.regionField (optional aggregation + valueField).",
  dataBinding: snapshotBinding("chart-choropleth"),
  name: "Choropleth Map",
  description:
    "World map shading countries by an aggregated value. Buckets entities by a region property (ISO country code or name) and tints each country on a sequential ramp — use for geographic distribution (e.g. customers per country, revenue by region).",
  icon: "Map",
  category: "charts",
  semanticSection: "visualize",
  requiresSetup: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    {
      key: "filter",
      label: "Property filter",
      type: "filter",
      dependsOn: "profileSlug",
    },
    {
      key: "regionField",
      label: "Region property",
      type: "property",
      dependsOn: "profileSlug",
      required: true,
      description: "ISO country code (e.g. US / USA / 840) or country name",
    },
    {
      key: "aggregation",
      label: "Aggregation",
      type: "select",
      defaultValue: "count",
      options: [
        { value: "count", label: "Count" },
        { value: "sum", label: "Sum" },
        { value: "avg", label: "Average" },
      ],
    },
    {
      key: "valueField",
      label: "Property (for sum/avg)",
      type: "property",
      dependsOn: "profileSlug",
    },
    { key: "color", label: "Map color", type: "color" },
    { key: "label", label: "Display label", type: "string" },
  ],
  presets: [
    {
      label: "Entities by country",
      icon: "Map",
      config: { aggregation: "count", label: "By country" },
    },
  ],
};

// ─── Knowledge / PKM ─────────────────────────────────────────────────────────

// quickCapture removed — capture-flow replaces it
// randomHighlight removed — entity-spotlight covers this use case
// quoteCard removed — entity-spotlight covers quote display

const readingProgress: WidgetCapabilityDef = {
  key: "reading-progress",
  package: "synap.bento-widgets",
  dataBinding: QUERY_BINDING,
  name: "Reading Progress",
  description:
    "Progress bar for a book or any entity with a page / position count",
  icon: "BookOpen",
  category: "data",
  displayModes: ["compact", "medium"],
  defaultSize: { w: 4, h: 3 },
  requiresWorkspace: true,
  // Demoted to a Stat Card preset ("Reading Progress"). Hidden from the picker;
  // key + cell stay registered so existing blocks keep rendering.
  hiddenFromPicker: true,
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile slug",
      type: "profile",
      defaultValue: "book",
    },
    {
      key: "statusField",
      label: "Status property",
      type: "property",
      dependsOn: "profileSlug",
      defaultValue: "status",
    },
    {
      key: "activeStatus",
      label: "Active status value",
      type: "string",
      defaultValue: "reading",
      description: "e.g. 'reading', 'in-progress'",
    },
    {
      key: "pageField",
      label: "Current page property",
      type: "property",
      dependsOn: "profileSlug",
      defaultValue: "current-page",
    },
    {
      key: "totalPagesField",
      label: "Total pages property",
      type: "property",
      dependsOn: "profileSlug",
      defaultValue: "pages",
    },
    {
      key: "title",
      label: "Widget title",
      type: "string",
      defaultValue: "Currently Reading",
    },
    { key: "color", label: "Accent color", type: "color" },
  ],
};

// ─── Tracking / progress (Tabler-inspired) ───────────────────────────────────

const activityTracker: WidgetCapabilityDef = {
  key: "activity-tracker",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint:
    "Activity heat-map over time for a profile: config.profileSlug (optional dateField, timePeriod).",
  dataBinding: QUERY_BINDING,
  name: "Activity Tracker",
  description:
    "Streak / uptime bars — activity over time for a profile, GitHub-contribution style",
  icon: "Activity",
  category: "data",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 3 },
  requiresWorkspace: true,
  requiresSetup: true,
  semanticSection: "track-monitor",
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile",
      type: "profile",
      required: true,
    },
    {
      key: "dateField",
      label: "Date property",
      type: "property",
      dependsOn: "profileSlug",
      description: "Property to bucket on. Defaults to creation time.",
    },
    {
      key: "timePeriod",
      label: "Granularity",
      type: "select",
      defaultValue: "day",
      options: [
        { value: "day", label: "Daily" },
        { value: "week", label: "Weekly" },
        { value: "month", label: "Monthly" },
      ],
    },
    {
      key: "buckets",
      label: "Number of buckets",
      type: "number",
      defaultValue: 30,
    },
    { key: "title", label: "Widget title", type: "string" },
    { key: "color", label: "Accent color", type: "color" },
  ],
};

const compositionBar: WidgetCapabilityDef = {
  key: "composition-bar",
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug", "groupBy"],
  aiHint:
    "Stacked share of a profile by a property: config.profileSlug + config.groupBy.",
  dataBinding: QUERY_BINDING,
  name: "Composition Bar",
  description:
    "Single stacked bar showing a breakdown by a property (e.g. tasks by status)",
  icon: "BarChart2",
  category: "data",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 2 },
  requiresWorkspace: true,
  requiresSetup: true,
  semanticSection: "track-monitor",
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile",
      type: "profile",
      required: true,
    },
    {
      key: "groupBy",
      label: "Group by property",
      type: "property",
      dependsOn: "profileSlug",
      required: true,
      description: "e.g. status, priority, stage",
    },
    { key: "title", label: "Widget title", type: "string" },
    {
      key: "maxSegments",
      label: "Max segments",
      type: "number",
      defaultValue: 6,
      description: "Remainder collapses into 'Other'",
    },
    {
      key: "showLegend",
      label: "Show legend",
      type: "boolean",
      defaultValue: true,
    },
  ],
};

const entityProgress: WidgetCapabilityDef = {
  key: "entity-progress",
  package: "synap.bento-widgets",
  dataBinding: QUERY_BINDING,
  name: "Entity Progress",
  description:
    "Horizontal stepper showing where an entity sits in its stage/status pipeline",
  icon: "Milestone",
  category: "entity",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 2 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "stageField",
      label: "Stage property",
      type: "string",
      defaultValue: "status",
      description:
        "Property holding the current stage. Steps come from its select options.",
    },
    {
      key: "stages",
      label: "Stages override",
      type: "string",
      description:
        "Optional comma-separated stage values. Leave blank to use the property's options.",
    },
    { key: "title", label: "Widget title", type: "string" },
    { key: "color", label: "Accent color", type: "color" },
  ],
};

// ─── Utility ─────────────────────────────────────────────────────────────────

const quickAccess: WidgetCapabilityDef = {
  key: "quick-access",
  package: "synap.core-widgets",
  requiredConfig: [],
  aiHint:
    "Pinned shortcuts. config.items[] of { kind: view|entity|url, \u2026 }.",
  name: "Quick Access",
  description: "Pinned shortcuts to frequently accessed views or entities",
  icon: "Zap",
  category: "productivity",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 3 },
  // Demoted (soft): hidden from the picker. The cell renders a curated fixed
  // in-app action set and reads no config, so it can't be a faithful link-grid
  // preset — a "Quick Access" link-grid preset stands in. Key + cell stay
  // registered so existing blocks keep rendering.
  hiddenFromPicker: true,
  // No settings: QuickAccessCell renders a curated fixed action set and reads no
  // config (the former `items`/`columns` fields were phantom — the cell ignored
  // them). An empty schema makes the settings panel honestly show "no settings".
  configSchema: [],
};

const profilesLauncher: WidgetCapabilityDef = {
  key: "profiles-launcher",
  name: "Profiles",
  description:
    "The workspace's data types as cards — open one to work in its dashboard.",
  icon: "LayoutGrid",
  category: "data",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 6 },
  requiresWorkspace: true,
  configSchema: [],
};

const feed: WidgetCapabilityDef = {
  key: "feed",
  package: "synap.core-widgets",
  requiredConfig: [],
  aiHint: "Recent activity. Optional config.limit.",
  dataBinding: QUERY_BINDING,
  name: "Activity Feed",
  description:
    "Recent activity across the workspace — entity changes, mentions, updates",
  icon: "Activity",
  category: "data",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 6 },
  requiresWorkspace: true,
  configSchema: [
    { key: "limit", label: "Max items", type: "number", defaultValue: 20 },
    {
      key: "profileSlug",
      label: "Scope to entity type",
      type: "profile",
      description: "e.g. 'task' — blank = all",
    },
    {
      key: "showAvatars",
      label: "Show user avatars",
      type: "boolean",
      defaultValue: true,
    },
  ],
};

const inbox: WidgetCapabilityDef = {
  key: "inbox",
  package: "synap.core-widgets",
  requiredConfig: [],
  aiHint: "Unread and actionable items. No required config.",
  dataBinding: QUERY_BINDING,
  name: "Inbox",
  description:
    "Actionable items requiring attention — tasks, proposals, notifications",
  icon: "Inbox",
  category: "productivity",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 6 },
  requiresWorkspace: true,
  configSchema: [
    { key: "limit", label: "Max items", type: "number", defaultValue: 20 },
    {
      key: "showTypes",
      label: "Item types to show",
      type: "variant",
      defaultValue: "all",
      options: [
        { value: "all", label: "All" },
        { value: "proposals", label: "Proposals only" },
        { value: "tasks", label: "Tasks only" },
        { value: "notifications", label: "Notifications only" },
      ],
    },
  ],
  presets: [
    { label: "All Inbox", icon: "Inbox", config: { showTypes: "all" } },
    {
      label: "Proposals Only",
      icon: "GitPullRequest",
      config: { showTypes: "proposals" },
    },
    {
      label: "Notifications",
      icon: "Bell",
      config: { showTypes: "notifications" },
    },
  ],
};

const linkGrid: WidgetCapabilityDef = {
  key: "link-grid",
  package: "synap.bento-widgets",
  requiredConfig: [],
  aiHint: "config.links[] of { label, url }; optional columns and title.",
  dataBinding: INLINE_BINDING,
  name: "Link Grid",
  description: "Grid of quick-access links to external URLs or internal views",
  icon: "LayoutGrid",
  category: "core",
  semanticSection: "layout-compose",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 3 },
  configSchema: [
    {
      key: "links",
      label: "Links",
      type: "list",
      description:
        "Quick-access links — each has a label, URL, and optional icon",
      itemSchema: [
        { key: "label", label: "Label", type: "string" },
        { key: "url", label: "URL", type: "url" },
        { key: "icon", label: "Icon", type: "icon" },
      ],
    },
    { key: "columns", label: "Columns", type: "number", defaultValue: 3 },
    { key: "title", label: "Section title", type: "string" },
  ],
  presets: [
    {
      // Soft replacement for the former `quick-access` widget (now hidden). The
      // original cell navigated to in-app surfaces (new doc / new chat / graph),
      // which a URL link-grid can't express — so this preset ships sensible
      // external defaults rather than reproducing the navigation actions.
      label: "Quick Access",
      icon: "Zap",
      config: {
        title: "Quick Access",
        columns: 3,
        links: [
          { label: "Docs", url: "https://synap.so/docs", icon: "FileText" },
          {
            label: "Community",
            url: "https://synap.so/community",
            icon: "Users",
          },
          {
            label: "Support",
            url: "https://synap.so/support",
            icon: "LifeBuoy",
          },
        ],
      },
    },
  ],
};

const iframeEmbed: WidgetCapabilityDef = {
  key: "iframe-embed",
  package: "synap.bento-widgets",
  requiredConfig: ["url"],
  aiHint: "config.url of an https page to embed.",
  dataBinding: NO_BINDING,
  name: "Web Embed",
  description: "Embed an external webpage, dashboard, or web app via iframe",
  icon: "Globe",
  category: "app-specific",
  semanticSection: "layout-compose",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 6 },
  configSchema: [
    { key: "url", label: "URL to embed", type: "url", required: true },
    { key: "title", label: "Title", type: "string" },
    {
      key: "allowFullscreen",
      label: "Allow fullscreen",
      type: "boolean",
      defaultValue: true,
    },
  ],
};

// ─── Communication / AI ───────────────────────────────────────────────────────

// NOTE: "channel" is the legacy key. New code should use "channel-view".
// Kept for backward compat with existing bento configs.
const channelWidget: WidgetCapabilityDef = {
  key: "channel",
  package: "synap.channels",
  name: "Channel (legacy)",
  description: "Embed a conversation channel thread in a bento dashboard",
  icon: "MessageSquare",
  category: "communication",
  semanticSection: "collaborate",
  displayModes: ["compact", "medium"],
  defaultSize: { w: 6, h: 4 },
  requiresWorkspace: true,
  aliasOf: "channel-view",
  configSchema: [{ key: "channelId", label: "Channel ID", type: "channel" }],
};

const channelFeed: WidgetCapabilityDef = {
  key: "channel-feed",
  package: "synap.channels",
  name: "Channel Feed",
  description: "Recent messages feed from a channel or all workspace channels",
  icon: "MessageCircle",
  category: "communication",
  semanticSection: "collaborate",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 6 },
  requiresWorkspace: true,
  configSchema: [
    { key: "channelId", label: "Channel ID (blank = all)", type: "channel" },
    { key: "limit", label: "Max messages", type: "number", defaultValue: 20 },
  ],
};

const aiChat: WidgetCapabilityDef = {
  key: "ai-chat",
  package: "synap.ai-chat",
  name: "AI Chat",
  description: "Embedded AI assistant chat panel",
  icon: "Bot",
  category: "ai",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 8 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "channelId",
      label: "Channel ID (blank = default agent chat)",
      type: "channel",
    },
    { key: "placeholder", label: "Input placeholder text", type: "string" },
  ],
};

const search: WidgetCapabilityDef = {
  key: "search",
  name: "Search",
  description: "Full-text search bar for entities, documents, and views",
  icon: "Search",
  category: "productivity",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 2 },
  requiresWorkspace: true,
  configSchema: [
    { key: "placeholder", label: "Placeholder text", type: "string" },
    { key: "profileSlug", label: "Scope to entity type", type: "profile" },
  ],
};

// notifications removed — inbox widget covers notification display

const documentEditor: WidgetCapabilityDef = {
  key: "document-editor",
  package: "synap.entity-views",
  name: "Document",
  description:
    "Embed a rich-text document viewer or editor in a bento dashboard",
  icon: "FileEdit",
  category: "content",
  semanticSection: "layout-compose",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 8, h: 10 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "profileSlug",
      label: "Profile",
      type: "profile",
      description:
        "Entity type to scope the entity picker. Auto-detected from the host entity on entity dashboards.",
    },
    {
      key: "entityId",
      label: "Entity (document owner)",
      type: "entity",
      dependsOn: "profileSlug",
      description:
        "Pick the entity whose document to show. This is the primary, precise path — the cell renders the entity's rich document.",
    },
    {
      key: "documentId",
      label: "Document ID (raw)",
      type: "string",
      description:
        "Escape hatch for a standalone document with no owning entity. Prefer the Entity picker above — documents are normally reached via their entity.",
    },
    {
      key: "viewMode",
      label: "Mode",
      type: "variant",
      defaultValue: "read",
      options: [
        { value: "read", label: "Read only" },
        { value: "edit", label: "Editable" },
      ],
    },
    { key: "title", label: "Widget title", type: "string" },
  ],
};

const entityRelationships: WidgetCapabilityDef = {
  key: "entity-relationships",
  package: "synap.entity-views",
  name: "Entity Relationships",
  description:
    "All relationship links for one entity (from the relations table). Filter by link type (e.g. parent_of, related_to, blocks). Use when you want to see every linked entity regardless of type; for a filtered list by target type use Related Items instead.",
  icon: "Share2",
  category: "entity",
  displayModes: ["compact", "medium"],
  defaultSize: { w: 4, h: 6 },
  requiresWorkspace: true,
  // Merged into Entity Links (Phase 2B). entity-links shows every linked entity
  // when no profile/relationship filter is set — i.e. the same "all relation
  // rows" view — and offers an "All Relationships" preset. Hidden from the
  // picker; key + cell + schema stay registered so existing
  // {kind:"widget",widgetType:"entity-relationships"} blocks keep rendering.
  hiddenFromPicker: true,
  configSchema: [
    {
      key: "_profileSlug",
      label: "Entity type",
      type: "profile",
      description:
        "Type to scope the entity picker (auto-detected from the host entity on entity dashboards).",
    },
    {
      key: "entityId",
      label: "Entity",
      type: "entity",
      dependsOn: "_profileSlug",
      description: "Which entity's relationships to show.",
    },
    {
      key: "relationType",
      label: "Relation type filter",
      type: "relation-type",
    },
    { key: "limit", label: "Max items", type: "number", defaultValue: 10 },
    { key: "title", label: "Widget title", type: "string" },
  ],
};

// ─── Communication (full views as widgets) ────────────────────────────────────

const channelNavigator: WidgetCapabilityDef = {
  key: "channel-navigator",
  package: "synap.channels",
  name: "Channel Navigator",
  description:
    "Channel list sidebar for browsing and switching workspace channels",
  icon: "MessageSquare",
  category: "communication",
  semanticSection: "collaborate",
  directAdd: true,
  displayModes: ["compact", "medium"],
  defaultSize: { w: 3, h: 8 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "variant",
      label: "Show channel types",
      type: "variant",
      defaultValue: "all",
      options: [
        { value: "all", label: "All channels" },
        { value: "ai", label: "AI threads only" },
        { value: "direct", label: "Direct channels only" },
      ],
    },
    { key: "limit", label: "Max channels", type: "number", defaultValue: 20 },
  ],
};

const channelView: WidgetCapabilityDef = {
  key: "channel-view",
  package: "synap.channels",
  requiredConfig: ["channelId"],
  aiHint: "One channel's thread: config.channelId.",
  name: "Channel View",
  description: "Full channel thread embedded in a bento dashboard",
  icon: "MessagesSquare",
  category: "communication",
  semanticSection: "collaborate",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 10 },
  requiresWorkspace: true,
  configSchema: [{ key: "channelId", label: "Channel ID", type: "channel" }],
};

// ─── Governance ───────────────────────────────────────────────────────────────

const proposalsList: WidgetCapabilityDef = {
  key: "proposals-list",
  package: "synap.proposals",
  requiredConfig: [],
  aiHint:
    "Pending proposals needing review. Optional config.status (default pending) and config.limit.",
  dataBinding: QUERY_BINDING,
  name: "Proposals",
  description: "AI proposals inbox — pending changes awaiting approval",
  icon: "CheckSquare",
  category: "governance",
  semanticSection: "automate-govern",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 8 },
  requiresWorkspace: true,
  configSchema: [
    {
      key: "layout",
      label: "Layout",
      type: "variant",
      defaultValue: "inbox",
      options: [
        { value: "inbox", label: "Inbox" },
        { value: "timeline", label: "Timeline" },
      ],
      description:
        "inbox = pending changes awaiting approval; timeline = chronological audit trail of all governance actions",
    },
    { key: "limit", label: "Max items", type: "number", defaultValue: 10 },
    {
      key: "status",
      label: "Filter by status",
      type: "select",
      options: [
        { value: "pending", label: "Pending" },
        { value: "approved", label: "Approved" },
        { value: "rejected", label: "Rejected" },
      ],
    },
  ],
  presets: [
    {
      label: "Proposal Timeline",
      icon: "GitBranch",
      config: { layout: "timeline" },
    },
  ],
};

const proposalDetail: WidgetCapabilityDef = {
  key: "proposal-detail",
  package: "synap.proposals",
  requiredConfig: ["proposalId"],
  aiHint: "One proposal: config.proposalId.",
  name: "Proposal Detail",
  description:
    "Full detail view of a single AI proposal with approve/reject actions",
  icon: "ClipboardCheck",
  category: "governance",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 8 },
  requiresWorkspace: true,
  // Rarely added by hand — reached via proposals-list drill-down.
  hiddenFromPicker: true,
  configSchema: [{ key: "proposalId", label: "Proposal ID", type: "string" }],
};

const proposalTimeline: WidgetCapabilityDef = {
  key: "proposal-timeline",
  package: "synap.proposals",
  name: "Proposal Timeline",
  description: "Chronological timeline of AI proposals and governance actions",
  icon: "GitBranch",
  category: "governance",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 8, h: 6 },
  requiresWorkspace: true,
  // Folded into proposals-list (preset "Proposal Timeline" → {layout:"timeline"}).
  // Key + registration retained so existing blocks render; hidden from the picker.
  hiddenFromPicker: true,
  configSchema: [
    { key: "limit", label: "Max items", type: "number", defaultValue: 20 },
    { key: "title", label: "Widget title", type: "string" },
  ],
};

// ─── Workflows / Automations ─────────────────────────────────────────────────

const workflowList: WidgetCapabilityDef = {
  key: "workflow-list",
  package: "synap.workflows",
  name: "Workflows",
  description:
    "Grid of commands and automations — create, edit, and run AI workflows",
  icon: "Workflow",
  category: "ai",
  semanticSection: "automate-govern",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 8, h: 8 },
  requiresWorkspace: true,
  configSchema: [],
};

const automationDetail: WidgetCapabilityDef = {
  key: "automation-detail",
  package: "synap.workflows",
  requiredConfig: ["automationId"],
  aiHint: "One automation's card: config.automationId.",
  name: "Automation Card",
  description:
    "Rich automation card — flow preview, status, stats, run button, and recent runs. Adapts to compact/medium/full display mode.",
  icon: "Workflow",
  category: "ai",
  semanticSection: "automate-govern",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "automationId", label: "Automation ID", type: "automation" },
    {
      key: "compact",
      label: "Compact (status only)",
      type: "boolean",
      defaultValue: false,
      description:
        "Force the compact status view (status · trigger · last run · success rate) regardless of size",
    },
  ],
  presets: [
    {
      label: "Automation Status",
      icon: "Workflow",
      config: { compact: true },
    },
  ],
};

const automationFlow: WidgetCapabilityDef = {
  key: "automation-flow",
  package: "synap.workflows",
  requiredConfig: ["automationId"],
  aiHint: "One automation's flow diagram: config.automationId.",
  name: "Automation Flow",
  description:
    "Embeddable flow diagram — renders the full DAG of an automation. Ideal for whiteboards and documentation bento grids.",
  icon: "GitBranch",
  category: "ai",
  semanticSection: "automate-govern",
  directAdd: true,
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  configSchema: [
    { key: "automationId", label: "Automation ID", type: "automation" },
  ],
};

const automationStatus: WidgetCapabilityDef = {
  key: "automation-status",
  package: "synap.workflows",
  requiredConfig: ["automationId"],
  aiHint: "One automation's run status: config.automationId.",
  name: "Automation Status",
  description:
    "Single automation status card — shows status, trigger type, last run, and success rate",
  icon: "Workflow",
  category: "ai",
  displayModes: ["compact", "medium"],
  defaultSize: { w: 4, h: 3 },
  requiresWorkspace: true,
  // Folded into automation-detail (preset "Automation Status" → {compact:true}).
  // Key + registration retained so existing blocks render; hidden from the picker.
  hiddenFromPicker: true,
  configSchema: [
    { key: "automationId", label: "Automation ID", type: "automation" },
  ],
};

const commandDetail: WidgetCapabilityDef = {
  key: "command-detail",
  package: "synap.workflows",
  requiredConfig: ["commandId"],
  aiHint: "One command's card: config.commandId.",
  name: "Command Card",
  description:
    "Rich command card — prompt template preview, argument list, selection badge, and run button",
  icon: "Terminal",
  category: "ai",
  semanticSection: "automate-govern",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 4 },
  requiresWorkspace: true,
  configSchema: [{ key: "commandId", label: "Command ID", type: "command" }],
};

const triggerButton: WidgetCapabilityDef = {
  key: "trigger-button",
  package: "synap.workflows",
  requiredConfig: ["automationId"],
  aiHint: "A button that runs one automation: config.automationId.",
  name: "Trigger Button",
  description: "Button to manually trigger an automation",
  icon: "Play",
  category: "ai",
  semanticSection: "automate-govern",
  directAdd: true,
  displayModes: ["compact"],
  defaultSize: { w: 3, h: 2 },
  requiresWorkspace: true,
  configSchema: [
    { key: "automationId", label: "Automation ID", type: "automation" },
  ],
};

const runHistory: WidgetCapabilityDef = {
  key: "run-history",
  package: "synap.workflows",
  requiredConfig: ["automationId"],
  aiHint: "Recent runs of one automation: config.automationId.",
  name: "Run History",
  description: "Recent automation run feed with status indicators",
  icon: "History",
  category: "ai",
  semanticSection: "automate-govern",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 6 },
  requiresWorkspace: true,
  configSchema: [
    { key: "automationId", label: "Automation ID", type: "automation" },
    {
      key: "limit",
      label: "Max runs to show",
      type: "number",
      defaultValue: 10,
    },
  ],
};

// ─── Brand Library ───────────────────────────────────────────────────────────

const brandLibrarySummary: WidgetCapabilityDef = {
  key: "brand-library-summary",
  package: "synap.brand-library",
  name: "Brand Library",
  description:
    "Summary of the active brand source workspace: assets, tokens, templates, components, and rules",
  icon: "Palette",
  category: "data",
  displayModes: ["medium", "full"],
  defaultSize: { w: 6, h: 5 },
  requiresWorkspace: true,
  // Only relevant in brand workspaces — hidden from general picker.
  hiddenFromPicker: true,
  configSchema: [
    { key: "brandWorkspaceId", label: "Brand workspace ID", type: "string" },
  ],
};

const brandTokenPreview: WidgetCapabilityDef = {
  key: "brand-token-preview",
  package: "synap.brand-library",
  name: "Brand Tokens",
  description:
    "Preview colors, typography, and CSS variables from the active brand token set",
  icon: "SwatchBook",
  category: "data",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 4 },
  requiresWorkspace: true,
  hiddenFromPicker: true,
  configSchema: [{ key: "tokenSetId", label: "Token set ID", type: "string" }],
};

const brandTemplatePicker: WidgetCapabilityDef = {
  key: "brand-template-picker",
  package: "synap.brand-library",
  name: "Brand Templates",
  description:
    "Reusable branded templates for artboards, decks, banners, documents, and generated HTML",
  icon: "LayoutTemplate",
  category: "data",
  displayModes: ["medium", "full"],
  defaultSize: { w: 5, h: 4 },
  requiresWorkspace: true,
  hiddenFromPicker: true,
  configSchema: [
    { key: "brandWorkspaceId", label: "Brand workspace ID", type: "string" },
    { key: "templateKind", label: "Template kind", type: "string" },
  ],
};

// ─── View embeds ──────────────────────────────────────────────────────────────

// ONE generic "view" widget collapses the six former view-* TYPES (view-table,
// view-list, view-kanban, view-calendar, view-grid, view-map) into a single
// pickable type with a `layout` variant. Each former type now survives only as a
// hidden `aliasOf: "view"` entry (keys stay frozen, old blocks keep rendering),
// and each layout is offered as a PRESET on this generic widget. The `view` cell
// renders from `{ viewId, layout }` (registerViewRunnerCells), honoring
// `config.layout` via ViewCell's `layoutOverride`.
const viewWidget: WidgetCapabilityDef = {
  key: "view" as WidgetTypeKey,
  package: "synap.views",
  requiredConfig: ["viewId"],
  aiHint:
    "Embed a SAVED view: config.viewId is a view UUID (synap_list_views). Optional config.layout: table|list|kanban|calendar|grid. A profileSlug is NOT enough \u2014 use entity-list for that.",
  dataBinding: QUERY_BINDING,
  name: "View",
  description:
    "Embed a saved data view in this dashboard. Choose the layout (table, list, kanban, calendar, grid) it projects the entities as.",
  icon: "LayoutGrid",
  category: "data",
  semanticSection: "browse-explore",
  requiresSetup: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 12, h: 8 },
  minSize: { w: 3, h: 3 },
  requiresWorkspace: true,
  configSchema: [
    { key: "viewId", label: "View", type: "view" },
    {
      key: "layout",
      label: "Layout",
      type: "variant",
      defaultValue: "table",
      options: [
        { value: "table", label: "Table" },
        { value: "list", label: "List" },
        { value: "kanban", label: "Kanban" },
        { value: "calendar", label: "Calendar" },
        { value: "grid", label: "Grid" },
      ],
    },
  ],
  presets: [
    { label: "Table View", icon: "Table2", config: { layout: "table" } },
    { label: "List View", icon: "List", config: { layout: "list" } },
    { label: "Kanban View", icon: "Columns", config: { layout: "kanban" } },
    {
      label: "Calendar View",
      icon: "CalendarDays",
      config: { layout: "calendar" },
    },
    { label: "Grid View", icon: "LayoutGrid", config: { layout: "grid" } },
  ],
};

// Former view-* TYPES, now hidden aliases of the generic `view` widget. Keys stay
// frozen (typeKey-stability) and the cells stay registered so persisted blocks
// `{kind:"widget",widgetType:"view-kanban",...}` keep rendering. New dashboards
// reach these via the `view` widget's layout presets above. `view-map` has no
// layout preset (map view unimplemented) — it is hidden but NOT aliased, so its
// own config schema is preserved for any old block.
const viewAlias = (
  key:
    "view-table" | "view-list" | "view-kanban" | "view-calendar" | "view-grid",
  name: string,
  icon: string,
  defaultSize: { w: number; h: number }
): WidgetCapabilityDef => ({
  key,
  name: `${name} (legacy)`,
  description: `Legacy alias for the View widget — use the View widget's ${name.replace(" View", "")} layout for new dashboards`,
  icon,
  category: "data",
  displayModes: ["compact", "medium", "full"],
  defaultSize,
  requiresWorkspace: true,
  aliasOf: "view" as WidgetTypeKey,
  package: "synap.views",
  requiredConfig: ["viewId"],
  aiHint: `Legacy alias of \`view\` (layout=${key.replace("view-", "")}). Prefer \`view\` for new layouts; config.viewId is a saved view UUID.`,
  dataBinding: QUERY_BINDING,
  configSchema: [
    { key: "viewId", label: "View", type: "view" },
    {
      key: "layout",
      label: "Layout",
      type: "variant",
      defaultValue: key.replace("view-", ""),
      options: [
        { value: "table", label: "Table" },
        { value: "list", label: "List" },
        { value: "kanban", label: "Kanban" },
        { value: "calendar", label: "Calendar" },
        { value: "grid", label: "Grid" },
      ],
    },
  ],
});

const viewMapWidget: WidgetCapabilityDef = {
  key: "view-map",
  package: "synap.views",
  dataBinding: QUERY_BINDING,
  name: "Map View",
  description: "Embed a map view directly in a bento dashboard",
  icon: "MapPin",
  category: "data",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 12, h: 8 },
  requiresWorkspace: true,
  // Map view is unimplemented — hidden from the picker. Key stays frozen so any
  // existing block renders (ViewCell falls back gracefully).
  hiddenFromPicker: true,
  configSchema: [
    { key: "viewId", label: "View", type: "view" },
    {
      key: "layout",
      label: "Layout",
      type: "variant",
      defaultValue: "map",
      options: [{ value: "map", label: "Map" }],
    },
  ],
};

const mapWidget: WidgetCapabilityDef = {
  key: "map-widget",
  package: "synap.bento-widgets",
  name: "Map",
  description:
    "Show entity locations on an interactive map. Supports single entity or filtered by profile.",
  icon: "MapPin",
  category: "data",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 6 },
  requiresWorkspace: true,
  // Hidden from the add-block picker: the implementation is a stub that renders
  // null (view-map unpublished). Key stays frozen so existing blocks render.
  hiddenFromPicker: true,
  configSchema: [
    { key: "profileSlug", label: "Entity type filter", type: "profile" },
    {
      key: "entityId",
      label: "Entity ID",
      type: "entity",
      dependsOn: "profileSlug",
    },
    {
      key: "locationField",
      label: "Location property",
      type: "property",
      dependsOn: "profileSlug",
    },
    { key: "showRoutes", label: "Draw route lines", type: "boolean" },
    { key: "zoom", label: "Zoom level", type: "number" },
  ],
};

// ─── Proactive AI ─────────────────────────────────────────────────────────────

const proactiveInsight: WidgetCapabilityDef = {
  key: "proactive-insight",
  package: "synap.proactive-ai",
  name: "AI Insight",
  description: "Proactive AI insight, suggestion, or alert",
  icon: "Sparkles",
  category: "ai",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 4 },
  configSchema: [],
};

const proactiveFeed: WidgetCapabilityDef = {
  key: "proactive-feed",
  package: "synap.proactive-ai",
  name: "Proactive AI Feed",
  description:
    "Feed of recent proactive AI messages (briefings, digests, insights)",
  icon: "Sparkles",
  category: "ai",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 6 },
  configSchema: [
    { key: "limit", label: "Max items", type: "number", defaultValue: 5 },
  ],
};

// ─── AI Action Cards ─────────────────────────────────────────────────────────

const aiProposedAction: WidgetCapabilityDef = {
  key: "ai-proposed-action",
  package: "synap.ai-chat",
  name: "AI Proposed Action",
  description:
    "AI-proposed entity/view/profile/relation creation card with approve/dismiss actions",
  icon: "GitBranch",
  category: "ai",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 3 },
  // System-generated cell — AI emits these, users don't add them from the picker.
  hiddenFromPicker: true,
  configSchema: [
    {
      key: "action",
      label: "Proposed action data",
      type: "object",
      required: true,
      description: "ProposedAction object with id, toolName, args",
    },
    {
      key: "initialStatus",
      label: "Initial status",
      type: "select",
      defaultValue: "approved",
      options: [
        { value: "pending", label: "Pending" },
        { value: "approved", label: "Approved" },
        { value: "dismissed", label: "Dismissed" },
      ],
    },
  ],
};

const aiDocProposal: WidgetCapabilityDef = {
  key: "ai-doc-proposal",
  package: "synap.ai-chat",
  name: "AI Document Proposal",
  description:
    "AI-proposed document creation or update card with approve/dismiss and diff viewer",
  icon: "Sparkles",
  category: "ai",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 4 },
  hiddenFromPicker: true,
  configSchema: [
    { key: "title", label: "Document title", type: "string", required: true },
    { key: "excerpt", label: "Content excerpt", type: "string" },
    {
      key: "mode",
      label: "Mode",
      type: "select",
      defaultValue: "create",
      options: [
        { value: "create", label: "Create" },
        { value: "update", label: "Update" },
      ],
    },
    {
      key: "initialStatus",
      label: "Initial status",
      type: "select",
      defaultValue: "approved",
      options: [
        { value: "pending", label: "Pending" },
        { value: "approved", label: "Approved" },
        { value: "dismissed", label: "Dismissed" },
      ],
    },
  ],
};

const aiWorkspaceProposal: WidgetCapabilityDef = {
  key: "ai-workspace-proposal",
  package: "synap.ai-chat",
  name: "AI Workspace Proposal",
  description:
    "AI-proposed full workspace setup with profiles, views, and sample entities",
  icon: "Sparkles",
  category: "ai",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 6 },
  hiddenFromPicker: true,
  configSchema: [
    {
      key: "proposal",
      label: "Workspace proposal data",
      type: "object",
      required: true,
      description: "WorkspaceProposalData object",
    },
    {
      key: "isCreated",
      label: "Already created",
      type: "boolean",
      defaultValue: false,
    },
  ],
};

const aiInbox: WidgetCapabilityDef = {
  key: "ai-inbox",
  package: "synap.bento-widgets",
  name: "AI Inbox",
  description: "Ambient pending proposals count and recent AI captures",
  icon: "Sparkles",
  category: "ai",
  semanticSection: "start-here",
  directAdd: true,
  displayModes: ["compact", "medium"],
  defaultSize: { w: 4, h: 3 },
  requiresWorkspace: true,
  configSchema: [],
};

const notificationsFeed: WidgetCapabilityDef = {
  key: "notifications-feed",
  package: "synap.proactive-ai",
  name: "Notifications Feed",
  description:
    "Unread notifications from the notification center (proposals, AI nudges, system)",
  icon: "Bell",
  category: "ai",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 6 },
  requiresWorkspace: true,
  // Covered by the Inbox widget — hidden to avoid duplication.
  hiddenFromPicker: true,
  configSchema: [
    { key: "limit", label: "Max items", type: "number", defaultValue: 10 },
  ],
};

const agentChatRecent: WidgetCapabilityDef = {
  key: "agent-chat-recent",
  package: "synap.proactive-ai",
  name: "Agent Chat",
  description: "Latest messages from your default agent chat channel",
  icon: "MessageSquare",
  category: "communication",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 6 },
  requiresWorkspace: true,
  // Covered by Channel Feed (with channelId = default agent channel) — hidden.
  hiddenFromPicker: true,
  configSchema: [
    { key: "limit", label: "Max messages", type: "number", defaultValue: 5 },
  ],
};

const entityContentAlias: WidgetCapabilityDef = {
  key: "entity-content" as WidgetTypeKey,
  package: "synap.bento-widgets",
  name: "Entity Links (legacy)",
  description:
    "Legacy alias for entity-links — use entity-links for new dashboards",
  icon: "Link2",
  category: "data",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 6 },
  requiresWorkspace: true,
  aliasOf: "entity-links" as WidgetTypeKey,
  configSchema: [],
};

const entityCountAlias: WidgetCapabilityDef = {
  key: "entity-count" as WidgetTypeKey,
  package: "synap.bento-widgets",
  requiredConfig: ["profileSlug"],
  aiHint: "Legacy alias of stat-card \u2014 use stat-card for new layouts.",
  dataBinding: QUERY_BINDING,
  name: "Entity Count (legacy)",
  description:
    "Legacy alias for stat-card — use stat-card with aggregation: count",
  icon: "Hash",
  category: "data",
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 3, h: 3 },
  requiresWorkspace: true,
  aliasOf: "stat-card" as WidgetTypeKey,
  configSchema: [
    { key: "profileSlug", label: "Profile", type: "profile", required: true },
    { key: "label", label: "Display label", type: "string" },
    { key: "icon", label: "Icon", type: "icon" },
    { key: "color", label: "Accent color", type: "color" },
  ],
};

// ─── Focus Sessions ───────────────────────────────────────────────────────────

const activeSessions: WidgetCapabilityDef = {
  key: "active-sessions",
  package: "synap.bento-widgets",
  name: "Active Sessions",
  description:
    "Shows active and recent focus sessions — goal-bound rooms where you work with agents",
  icon: "Target",
  category: "productivity",
  semanticSection: "collaborate",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 4 },
  configSchema: [
    {
      key: "workspaceId",
      label: "Workspace filter",
      type: "string",
      description: "Leave blank for all workspaces",
    },
    {
      key: "status",
      label: "Status filter",
      type: "select",
      defaultValue: "all",
      options: [
        { value: "all", label: "All sessions" },
        { value: "active", label: "Active only" },
        { value: "paused", label: "Active + Paused" },
      ],
    },
    {
      key: "maxItems",
      label: "Max items",
      type: "number",
      defaultValue: 4,
    },
    {
      key: "showNewButton",
      label: "Show 'New session' button",
      type: "boolean",
      defaultValue: true,
    },
  ],
};

const sessionGoalBar: WidgetCapabilityDef = {
  key: "session-goal-bar",
  package: "synap.bento-widgets",
  name: "Session Goal Bar",
  description:
    "Persistent banner showing the current session goal, progress, and participants",
  icon: "Target",
  category: "productivity",
  semanticSection: "collaborate",
  // Only shown in session context — not in the general add-block picker
  hiddenFromPicker: true,
  displayModes: ["compact", "full"],
  defaultSize: { w: 12, h: 2 },
  configSchema: [
    {
      key: "sessionId",
      label: "Session ID",
      type: "string",
    },
    {
      key: "dense",
      label: "Compact mode",
      type: "boolean",
      defaultValue: false,
    },
  ],
};

const agentRuns: WidgetCapabilityDef = {
  key: "agent-runs",
  package: "synap.bento-widgets",
  name: "Agent Runs",
  description:
    "Watch your agents work — a live feed of agent runs with model, tokens, cost, and outcome",
  icon: "Activity",
  category: "productivity",
  semanticSection: "collaborate",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 6, h: 4 },
  configSchema: [
    {
      key: "workspaceId",
      label: "Workspace filter",
      type: "string",
      description: "Leave blank for all workspaces",
    },
    {
      key: "maxItems",
      label: "Max items",
      type: "number",
      defaultValue: 8,
    },
  ],
};

const agentSpend: WidgetCapabilityDef = {
  key: "agent-spend",
  package: "synap.bento-widgets",
  name: "Agent Spend",
  description:
    "What your agents cost — total spend over a trailing window, per-day breakdown, and an honest count of runs whose price the provider never reported",
  icon: "Coins",
  category: "productivity",
  semanticSection: "collaborate",
  directAdd: true,
  displayModes: ["compact", "medium", "full"],
  defaultSize: { w: 4, h: 3 },
  configSchema: [
    {
      key: "workspaceId",
      label: "Workspace filter",
      type: "string",
      description: "Leave blank for all workspaces",
    },
    {
      key: "days",
      label: "Window (UTC days)",
      type: "number",
      defaultValue: 30,
      description: "1–90 days, ending today (UTC)",
    },
    {
      key: "hideChart",
      label: "Hide daily bars",
      type: "boolean",
      defaultValue: false,
    },
  ],
};

// ─── Exports ──────────────────────────────────────────────────────────────────

export const WIDGET_DEFINITIONS: WidgetCapabilityDef[] = [
  // Core
  greeting,
  sectionHeader,
  workspaceInfo,
  homeTabs,
  calendarWidget,
  // Data / Entity
  entityList,
  entityCard,
  entityHeader,
  entityProperties,
  entityLinks,
  entitySpotlight,
  entityGallery,
  // Metrics
  statCard,
  activityTracker,
  compositionBar,
  // Entity progress
  entityProgress,
  // Charts
  chartLine,
  chartArea,
  chartBar,
  chartPie,
  chartGauge,
  chartRing,
  chartRadar,
  chartScatter,
  chartFunnel,
  chartComposed,
  chartLiveLine,
  chartProfitLoss,
  chartSankey,
  chartChoropleth,
  // Knowledge
  readingProgress,
  // Utility
  quickAccess,
  profilesLauncher,
  feed,
  inbox,
  linkGrid,
  iframeEmbed,
  // Communication / AI
  channelWidget,
  channelFeed,
  aiChat,
  aiInbox,
  search,
  // Entity content
  documentEditor,
  entityRelationships,
  mapWidget,
  // Communication full views
  channelNavigator,
  channelView,
  // Governance
  proposalsList,
  proposalDetail,
  proposalTimeline,
  // Workflows / Automations
  workflowList,
  automationDetail,
  automationFlow,
  automationStatus,
  commandDetail,
  triggerButton,
  runHistory,
  // Brand Library
  brandLibrarySummary,
  brandTokenPreview,
  brandTemplatePicker,
  // Proactive AI
  proactiveInsight,
  proactiveFeed,
  notificationsFeed,
  agentChatRecent,
  // AI Action Cards
  aiProposedAction,
  aiDocProposal,
  aiWorkspaceProposal,
  // View embeds — ONE generic `view` widget + hidden legacy aliases
  viewWidget,
  viewAlias("view-table", "Table View", "Table2", { w: 12, h: 8 }),
  viewAlias("view-list", "List View", "List", { w: 6, h: 8 }),
  viewAlias("view-kanban", "Kanban View", "Columns", { w: 12, h: 8 }),
  viewAlias("view-calendar", "Calendar View", "CalendarDays", { w: 12, h: 8 }),
  viewAlias("view-grid", "Grid View", "LayoutGrid", { w: 8, h: 8 }),
  viewMapWidget,
  // Legacy aliases
  entityContentAlias,
  entityCountAlias,
  // Focus Sessions
  activeSessions,
  sessionGoalBar,
  agentRuns,
  agentSpend,
].map(withSnapshotFields);

/** Fast lookup map: widgetKey → definition */
export const WIDGET_BY_KEY: Record<string, WidgetCapabilityDef> =
  Object.fromEntries(WIDGET_DEFINITIONS.map((d) => [d.key, d]));
