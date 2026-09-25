/**
 * @synap-core/types/renderables — Core Types
 *
 * Pure TypeScript types for every renderable Synap thing (widget cells + view
 * types). Moved DOWN from `@synap-core/capabilities` (which re-exports it) so
 * the backend, IS and relay read the SAME catalog the browser registers from.
 * LEAF module: no zod, no drizzle, no React — import freely from any layer.
 */

import type { Placement } from "./content-kinds.js";
import type { ChartDataShape } from "./chart-data.js";

// ─── Display modes ────────────────────────────────────────────────────────────

export type DisplayMode = "compact" | "medium" | "full";

// ─── Widget (cell) keys ───────────────────────────────────────────────────────

/** All registered bento widget keys. */
export const WIDGET_TYPE_KEYS = [
  // Core / workspace
  "greeting",
  "section-header",
  "workspace-info",
  "home-tabs",
  "calendar",
  // Data / entity
  "entity-list",
  "entity-card",
  "entity-header",
  "entity-properties",
  "entity-links",
  "entity-content", // legacy alias for entity-links
  "entity-spotlight",
  "entity-gallery",
  "entity-progress",
  // Metrics
  "stat-card",
  "entity-count", // legacy alias for stat-card
  "activity-tracker",
  "composition-bar",
  // Charts (charts-as-cells)
  "chart-line",
  "chart-area",
  "chart-bar",
  "chart-pie",
  "chart-gauge",
  "chart-ring",
  "chart-radar",
  "chart-scatter",
  "chart-funnel",
  "chart-composed",
  "chart-live-line",
  "chart-profit-loss",
  "chart-sankey",
  "chart-choropleth",
  // Knowledge / PKM
  "reading-progress",
  // Utility
  "quick-access",
  "profiles-launcher",
  "feed",
  "inbox",
  "link-grid",
  "iframe-embed",
  "capture-flow",
  // View embeds (view-runner cells)
  "view", // generic view embed (layout variant); view-* below are hidden aliases
  "view-table",
  "view-list",
  "view-kanban",
  "view-calendar",
  "view-grid",
  "view-map",
  // Map
  "map-widget",
  // Communication / AI
  "channel",
  "channel-feed",
  "channel-navigator",
  "channel-view",
  "ai-chat",
  "ai-inbox",
  "search",
  // Entity content
  "document-editor",
  "entity-relationships",
  // Entity property widgets (property-value and property-group merged into entity-properties)
  // Governance
  "proposals-list",
  "proposal-detail",
  "proposal-timeline",
  // Workflows / automations
  "workflow-list",
  "automation-detail",
  "automation-flow",
  "automation-status",
  "command-detail",
  "trigger-button",
  "run-history",
  // Brand Library
  "brand-library-summary",
  "brand-token-preview",
  "brand-template-picker",
  // Proactive AI
  "proactive-insight",
  "proactive-feed",
  "notifications-feed",
  "agent-chat-recent",
  // AI Action Cards
  "ai-proposed-action",
  "ai-doc-proposal",
  "ai-workspace-proposal",
  // Welcome / onboarding
  "welcome",
  "welcome-header",
  // Focus Sessions
  "active-sessions",
  "session-goal-bar",
  // Agent runs ("watch your agent work")
  "agent-runs",
  // Agent spend ("what did I spend?")
  "agent-spend",
] as const;

/** A registered bento widget key — derived from {@link WIDGET_TYPE_KEYS}. */
export type WidgetTypeKey = (typeof WIDGET_TYPE_KEYS)[number];

// ─── View family (semantic axis) ──────────────────────────────────────────────

/**
 * The SEMANTIC family of a view — the dimension of the data each view projects
 * entities onto. Orthogonal to the runtime `category` (which tells the renderer
 * how to dispatch). Views within the same family share a query/config contract,
 * so switching between them preserves the full config.
 *
 *  - collection — flat set, no imposed axis; differ by density/medium
 *  - grouped    — projected onto a categorical property (1 or 2 axes)
 *  - temporal   — projected onto a timestamp; differ by time-zoom
 *  - relational — projected onto links between entities
 *  - spatial    — projected onto a place
 *  - composite  — freeform, not driven by a single query
 */
export type ViewFamily =
  | "collection"
  | "grouped"
  | "temporal"
  | "relational"
  | "spatial"
  | "composite";

// ─── View type keys ───────────────────────────────────────────────────────────

/** All supported structured view type strings. */
export const VIEW_TYPE_KEYS = [
  "sheet",
  "table",
  "list",
  "grid",
  "gallery",
  "kanban",
  "matrix",
  "masonry",
  "calendar",
  "gantt",
  "timeline",
  "graph",
  "flow",
  "branch_tree",
  "bento",
  "whiteboard",
  "mindmap",
  "map",
] as const;

/** A structured view type — derived from {@link VIEW_TYPE_KEYS}. */
export type ViewTypeKey = (typeof VIEW_TYPE_KEYS)[number];

// ─── Widget config interfaces ─────────────────────────────────────────────────

export interface GreetingConfig {
  /** Show today's date under the greeting (default: true) */
  showDate?: boolean;
  /** Show the "N captured today" line (default: true) */
  showCapturedToday?: boolean;
  /** Override the displayed name (falls back to the current user's name) */
  name?: string;
}

export interface SectionHeaderConfig {
  title?: string;
  /** Subtitle below the title */
  subtitle?: string;
  icon?: string;
  /** Profile slug to show count for */
  profileSlug?: string;
  showCount?: boolean;
  color?: string;
}

export interface CalendarConfig {
  /** Initial calendar view: month / week / day / agenda (FullCalendar view name) */
  defaultView?: "dayGridMonth" | "timeGridWeek" | "timeGridDay" | "listWeek";
  profileSlug?: string;
  dateField?: string;
  endDateField?: string;
  titleField?: string;
  colorField?: string;
}

export interface StatCardConfig {
  /** Entity profile to aggregate over */
  profileSlug?: string;
  /**
   * "metric" = single value (count, sum, avg, min, max).
   * "distribution" = breakdown by a property (e.g. status pie chart, bar by category).
   */
  displayMode?: "metric" | "distribution";
  /** Aggregation function (only for displayMode "metric") */
  aggregation?: "count" | "sum" | "avg" | "min" | "max" | "completion";
  /** Property: for metric sum/avg/min/max use number/date; for distribution any type (status, type, etc.) */
  field?: string;
  /** Optional filter object */
  filter?: Record<string, unknown>;
  /** Display label */
  label?: string;
  /** Accent hex color */
  color?: string;
  /** Lucide icon name */
  icon?: string;
  /** Chart: for metric use none/sparkline/bar/area/progress; for distribution use donut or bar */
  chartType?: "none" | "sparkline" | "bar" | "area" | "donut" | "progress";
  /** Status property for completion % aggregation (default: "status") */
  completionStatusField?: string;
  /** Comma-separated values that count as "done" (default: "done,completed") */
  completionDoneValues?: string;
  /** Prefix prepended to the value (e.g. "$") */
  prefix?: string;
  /** Suffix appended to the value (e.g. "%") */
  suffix?: string;
  /** Time period granularity for trend charts (default: "week") */
  timePeriod?: "day" | "week" | "month" | "quarter";
}

export interface ChartLineConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Property to aggregate (required for sum/avg/min/max; ignored for count) */
  valueField?: string;
  /** Aggregation function per time bucket */
  aggregation?: "count" | "sum" | "avg" | "min" | "max";
  /** Time-bucket granularity for the x axis */
  timePeriod?: "day" | "week" | "month";
  /** Line color — a token var string like var(--chart-2) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartAreaConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Property to aggregate (required for sum/avg/min/max; ignored for count) */
  valueField?: string;
  /** Aggregation function per time bucket */
  aggregation?: "count" | "sum" | "avg" | "min" | "max";
  /** Time-bucket granularity for the x axis */
  timePeriod?: "day" | "week" | "month";
  /** Area color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartBarConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** category = count per group-by value; trend = aggregated value per time bucket */
  mode?: "category" | "trend";
  /** Property whose distinct values become the bars (category mode) */
  groupBy?: string;
  /** Aggregation per time bucket (trend mode) */
  aggregation?: "count" | "sum" | "avg" | "min" | "max";
  /** Property to aggregate (trend sum/avg/min/max) */
  valueField?: string;
  /** Time-bucket granularity (trend mode) */
  timePeriod?: "day" | "week" | "month";
  /** Bar color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartPieConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Property whose distinct values become the slices (required) */
  groupBy?: string;
  /** Header accent color — a token var string (never a hex). Slices use the bridge palette. */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartGaugeConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** completion = % done; count/sum/avg = scalar normalized against `max` */
  aggregation?: "completion" | "count" | "sum" | "avg";
  /** Property to aggregate (for sum/avg) */
  valueField?: string;
  /** Ceiling the value maps to 100% against (ignored for completion) */
  max?: number;
  /** Arc color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartRingConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** completion = % done; count/sum/avg = scalar normalized against `max` */
  aggregation?: "completion" | "count" | "sum" | "avg";
  /** Property to aggregate (for sum/avg) */
  valueField?: string;
  /** Ceiling the value maps to 100% against (ignored for completion) */
  max?: number;
  /** Ring color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartRadarConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Numeric properties — one radar axis each (at least three) */
  metrics?: string[];
  /** How each metric is reduced across the entities */
  aggregation?: "avg" | "sum" | "count" | "min" | "max";
  /** Series color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartScatterConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Numeric property mapped to the x axis (required) */
  xField?: string;
  /** Numeric property mapped to the y axis (required) */
  yField?: string;
  /** Dot color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartFunnelConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Property whose distinct values become the funnel stages (required) */
  stageField?: string;
  /** Funnel color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartComposedConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Aggregation for the bar series */
  barAggregation?: "count" | "sum" | "avg" | "min" | "max";
  /** Property aggregated for the bars (ignored for count) */
  barField?: string;
  /** Aggregation for the line series */
  lineAggregation?: "count" | "sum" | "avg" | "min" | "max";
  /** Property aggregated for the line (ignored for count) */
  lineField?: string;
  /** Time-bucket granularity for the x axis */
  timePeriod?: "day" | "week" | "month";
  /** Bar color — a token var string like var(--chart-1) (never a hex) */
  barColor?: string;
  /** Line color — a token var string like var(--chart-2) (never a hex) */
  lineColor?: string;
  /** Legend label for the bar series */
  barLabel?: string;
  /** Legend label for the line series */
  lineLabel?: string;
  /** Display label */
  label?: string;
}

export interface ChartLiveLineConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Property to aggregate (required for sum/avg/min/max; ignored for count) */
  valueField?: string;
  /** Aggregation function per time bucket */
  aggregation?: "count" | "sum" | "avg" | "min" | "max";
  /** Time-bucket granularity for the x axis */
  timePeriod?: "day" | "week" | "month";
  /** Polling interval in seconds (default 30, minimum 5) */
  refreshSeconds?: number;
  /** Line color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartProfitLossConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Signed numeric property aggregated per bucket (can be negative) */
  valueField?: string;
  /** Aggregation function per time bucket */
  aggregation?: "count" | "sum" | "avg" | "min" | "max";
  /** Time-bucket granularity for the x axis */
  timePeriod?: "day" | "week" | "month";
  /** The baseline the fill diverges around (default 0) */
  baseline?: number;
  /** Display label */
  label?: string;
}

export interface ChartSankeyConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Property whose distinct values become the source (left) nodes (required) */
  sourceField?: string;
  /** Property whose distinct values become the target (right) nodes (required) */
  targetField?: string;
  /** Header accent color — a token var string (never a hex). Nodes use the bridge palette. */
  color?: string;
  /** Display label */
  label?: string;
}

export interface ChartChoroplethConfig {
  /** Entity profile to aggregate over (required) */
  profileSlug?: string;
  /** Optional property filter */
  filter?: Record<string, unknown>;
  /** Property holding the region (ISO country code or name) (required) */
  regionField?: string;
  /** How entities are reduced per region */
  aggregation?: "count" | "sum" | "avg";
  /** Numeric property reduced for sum/avg (ignored for count) */
  valueField?: string;
  /** Map ramp base color — a token var string like var(--chart-1) (never a hex) */
  color?: string;
  /** Display label */
  label?: string;
}

export interface EntityListConfig {
  profileSlug?: string;
  title?: string;
  /** Max items to display */
  limit?: number;
  /** Property filter, e.g. { "status": "active" } */
  filter?: Record<string, unknown>;
  /** Property to sort by */
  sortField?: string;
  sortDirection?: "asc" | "desc";
  color?: string;
}

export interface EntityCountConfig {
  profileSlug?: string;
  /** Property filter */
  filter?: Record<string, unknown>;
  label?: string;
  color?: string;
  icon?: string;
}

export interface EntityCardConfig {
  /** Pin a specific entity by ID */
  entityId?: string;
  profileSlug?: string;
  /** Properties to show */
  showFields?: string[];
}

export interface EntitySpotlightConfig {
  profileSlug?: string;
  /** daily = stable day pick, random = refresh button, pinned = same as daily */
  seed?: "daily" | "random" | "pinned";
  /** detail = full layout, compact = title only */
  layout?: "detail" | "compact";
  /** Property to use as title (falls back to entity.title) */
  titleField?: string;
  /** Property to show as subtitle, e.g. "author" */
  subtitleField?: string;
  color?: string;
}

export interface EntityGalleryConfig {
  profileSlug?: string;
  /** Property containing image URL */
  coverField?: string;
  title?: string;
  limit?: number;
  /** Property filter */
  filter?: Record<string, unknown>;
  color?: string;
}

export interface ReadingProgressConfig {
  /** Entity type to query, default "book" */
  profileSlug?: string;
  /** Property that marks status, default "status" */
  statusField?: string;
  /** Value of statusField to filter on, default "reading" */
  activeStatus?: string;
  /** Current position property, default "current-page" */
  pageField?: string;
  /** Total length property, default "pages" */
  totalPagesField?: string;
  title?: string;
  color?: string;
}

export interface ActivityTrackerConfig {
  /** Entity profile to track over time */
  profileSlug?: string;
  /** Date property to bucket on; falls back to the entity createdAt */
  dateField?: string;
  /** Bucket granularity (default "day") */
  timePeriod?: "day" | "week" | "month";
  /** Number of buckets to render (default 30) */
  buckets?: number;
  /** Accent color for active buckets */
  color?: string;
  /** Widget title */
  title?: string;
}

export interface EntityProgressConfig {
  /** Entity to show progress for (falls back to the bento context entity) */
  entityId?: string;
  /** Property holding the stage/status value (default "status") */
  stageField?: string;
  /**
   * Explicit ordered stage values (comma-separated). When omitted, stages are
   * read from the profile property's select options.
   */
  stages?: string;
  /** Accent color */
  color?: string;
  /** Widget title */
  title?: string;
}

export interface CompositionBarConfig {
  /** Entity profile to break down */
  profileSlug?: string;
  /** Property to group by (e.g. "status", "priority") */
  groupBy?: string;
  /** Widget title */
  title?: string;
  /** Max segments before the remainder collapses into "Other" (default 6) */
  maxSegments?: number;
  /** Show the legend below the bar (default true) */
  showLegend?: boolean;
}

export interface QuoteCardConfig {
  profileSlug?: string;
  /** Property containing quote text, default "text" */
  textField?: string;
  /** Property containing author name, default "author" */
  authorField?: string;
  seed?: "daily" | "random";
  color?: string;
}

export interface QuickCaptureConfig {
  /** Default profile slug for new entity */
  profileSlug?: string;
  /** Widget label */
  label?: string;
  placeholder?: string;
  color?: string;
}

export interface RandomHighlightConfig {
  profileSlug?: string;
  /** Widget title */
  title?: string;
  /** Property containing the highlight text, default "text" */
  textField?: string;
  /** Property containing source title, e.g. "source" or "book" */
  sourceField?: string;
  seed?: "daily" | "random";
  color?: string;
}

export interface LinkGridConfig {
  links?: Array<{ label: string; url: string; icon?: string }>;
  columns?: number;
  title?: string;
}

export interface IframeEmbedConfig {
  url?: string;
  title?: string;
  allowFullscreen?: boolean;
}

export interface EntityContentConfig {
  /** Parent entity whose links to show (defaults to host entity context) */
  entityId?: string;
  /** Filter related items to this profile type */
  profileSlug?: string;
  /** Filter by a specific relationship type */
  relationshipType?: string;
  /** Display variant */
  variant?: "list" | "board";
  /** Max items to display */
  limit?: number;
}

export interface EntityPropertiesConfig {
  /** Profile slug — scopes the property pickers (auto-detected from host entity on entity dashboards) */
  profileSlug?: string;
  /** Display mode: all = all properties, single = one property, group = named subset */
  mode?: "all" | "single" | "group";
  /** Property slug to display (single mode) */
  propertyKey?: string;
  /** Ordered list of property slugs (group mode) */
  properties?: string[];
  /** Card title (group mode) */
  title?: string;
  /** Pin a specific entity */
  entityId?: string;
  /** Display variant */
  variant?: "compact" | "default" | "full";
  /** Number of columns (group mode, default: 1) */
  columns?: 1 | 2;
  /** Show empty properties (group mode, default: false) */
  showEmpty?: boolean;
  /** Label override (single mode) */
  label?: string;
  /** Whether to show label (single mode) */
  showLabel?: boolean;
}

export interface DocumentEditorConfig {
  /** Profile slug — scopes the entity picker (auto-detected from host entity on entity dashboards) */
  profileSlug?: string;
  /** Primary, precise path: the entity whose document to render */
  entityId?: string;
  /** Escape hatch: a standalone document with no owning entity */
  documentId?: string;
  /** read = view-only, edit = editable */
  viewMode?: "read" | "edit";
  title?: string;
}

export interface EntityRelationshipsConfig {
  entityId?: string;
  /** Filter to a specific relation type */
  relationType?: string;
  limit?: number;
  title?: string;
}

export interface ChannelViewConfig {
  channelId?: string;
}

export interface ChannelFeedConfig {
  /** Pin a channel; blank = all workspace channels */
  channelId?: string;
  /** Max messages to show */
  limit?: number;
}

export interface ChannelNavigatorConfig {
  /** Which channel types to list */
  variant?: "all" | "ai" | "direct";
  /** Max channels to show */
  limit?: number;
}

export interface AIChatConfig {
  /** Pin a channel; blank = default agent chat */
  channelId?: string;
  /** Input placeholder text */
  placeholder?: string;
}

export interface ProposalsListConfig {
  limit?: number;
  /** Filter by status: pending, approved, rejected */
  status?: "pending" | "approved" | "rejected";
}

export interface ProposalDetailConfig {
  proposalId?: string;
}

export interface ProposalTimelineConfig {
  limit?: number;
  title?: string;
}

export interface PropertyValueConfig {
  /** Slug of the property to display */
  propertySlug: string;
  /** Pin a specific entity (overrides BentoEditContext.entityId) */
  entityId?: string;
  /** Label override (default: property label from profile) */
  label?: string;
  /** Whether to show the label above the value (default: true for medium/full) */
  showLabel?: boolean;
  /** Optional hex accent color for the widget header */
  accentColor?: string;
}

export interface PropertyGroupConfig {
  /** Card title (e.g. "Contact Info", "Financials") */
  title?: string;
  /** Ordered list of property slugs to display */
  properties: string[];
  /** Pin a specific entity (overrides BentoEditContext.entityId) */
  entityId?: string;
  /** Number of columns inside the card (default: 1) */
  columns?: 1 | 2;
  /** Whether to show empty properties (default: false) */
  showEmpty?: boolean;
}

export interface ViewEmbedConfig {
  /** The view ID to embed */
  viewId?: string;
  /** Layout the embedded view is projected as (table | list | kanban | calendar | grid | map). */
  layout?: "table" | "list" | "kanban" | "calendar" | "grid" | "map";
}

// ─── AI Action Card configs ───────────────────────────────────────────────────

export interface AIProposedActionConfig {
  /** The ProposedAction data object */
  action?: Record<string, unknown>;
  /** Override initial status: "pending" | "approved" | "dismissed" */
  initialStatus?: string;
}

export interface AIDocProposalConfig {
  /** Document title */
  title?: string;
  /** Short excerpt */
  excerpt?: string;
  /** "create" or "update" */
  mode?: "create" | "update";
  /** Override initial status */
  initialStatus?: string;
}

export interface AIWorkspaceProposalConfig {
  /** The WorkspaceProposalData object */
  proposal?: Record<string, unknown>;
  /** Whether the workspace is already created */
  isCreated?: boolean;
}

export interface ActiveSessionsConfig {
  /** Filter to a specific workspace; leave blank for all workspaces */
  workspaceId?: string;
  status?: "active" | "paused" | "all";
  maxItems?: number;
  showNewButton?: boolean;
}

/** Config for the agent-runs feed cell ("watch your agent work"). */
export interface AgentRunsConfig {
  /** Filter to a specific workspace; leave blank for all workspaces */
  workspaceId?: string;
  /** Max runs to show */
  maxItems?: number;
  /** Compact/dense rows */
  density?: "compact" | "default";
}

/** Config for the agent-spend summary cell ("what did I spend?"). */
export interface AgentSpendConfig {
  /** Filter to a specific workspace; leave blank for all workspaces */
  workspaceId?: string;
  /** Trailing window length in UTC days (1–90) */
  days?: number;
  /** Hide the per-day bars — for a very small tile */
  hideChart?: boolean;
}

export interface SessionGoalBarConfig {
  sessionId?: string;
  /** Compact/dense mode */
  dense?: boolean;
}

export interface BrandLibrarySummaryConfig {
  brandWorkspaceId?: string;
}

export interface BrandTokenPreviewConfig {
  tokenSetId?: string;
  tokenPreview?: Record<string, unknown>;
}

export interface BrandTemplatePickerConfig {
  brandWorkspaceId?: string;
  templateKind?: string;
}

// ─── Discriminated union: widget key → config ─────────────────────────────────

export interface WidgetConfigByType {
  greeting: GreetingConfig;
  "section-header": SectionHeaderConfig;
  "workspace-info": Record<string, never>;
  "home-tabs": Record<string, never>;
  calendar: CalendarConfig;
  "entity-list": EntityListConfig;
  "entity-card": EntityCardConfig;
  "entity-header": Record<string, never>;
  "entity-properties": EntityPropertiesConfig;
  "entity-links": EntityContentConfig;
  "entity-content": EntityContentConfig; // legacy alias
  "entity-spotlight": EntitySpotlightConfig;
  "entity-gallery": EntityGalleryConfig;
  "entity-progress": EntityProgressConfig;
  "stat-card": StatCardConfig;
  "entity-count": StatCardConfig; // legacy alias for stat-card
  "activity-tracker": ActivityTrackerConfig;
  "composition-bar": CompositionBarConfig;
  "chart-line": ChartLineConfig;
  "chart-area": ChartAreaConfig;
  "chart-bar": ChartBarConfig;
  "chart-pie": ChartPieConfig;
  "chart-gauge": ChartGaugeConfig;
  "chart-ring": ChartRingConfig;
  "chart-radar": ChartRadarConfig;
  "chart-scatter": ChartScatterConfig;
  "chart-funnel": ChartFunnelConfig;
  "chart-composed": ChartComposedConfig;
  "chart-live-line": ChartLiveLineConfig;
  "chart-profit-loss": ChartProfitLossConfig;
  "chart-sankey": ChartSankeyConfig;
  "chart-choropleth": ChartChoroplethConfig;
  "reading-progress": ReadingProgressConfig;
  "quick-access": Record<string, unknown>;
  "profiles-launcher": Record<string, unknown>;
  feed: Record<string, unknown>;
  inbox: Record<string, unknown>;
  "link-grid": LinkGridConfig;
  "iframe-embed": IframeEmbedConfig;
  view: ViewEmbedConfig;
  "view-table": ViewEmbedConfig;
  "view-list": ViewEmbedConfig;
  "view-kanban": ViewEmbedConfig;
  "view-calendar": ViewEmbedConfig;
  "view-grid": ViewEmbedConfig;
  "view-map": ViewEmbedConfig;
  "map-widget": Record<string, unknown>;
  channel: ChannelViewConfig; // legacy alias for channel-view
  "channel-feed": ChannelFeedConfig;
  "channel-navigator": ChannelNavigatorConfig;
  "channel-view": ChannelViewConfig;
  "ai-chat": AIChatConfig;
  "ai-inbox": Record<string, unknown>;
  "capture-flow": Record<string, unknown>;
  search: Record<string, unknown>;
  "document-editor": DocumentEditorConfig;
  "entity-relationships": EntityRelationshipsConfig;
  "proposals-list": ProposalsListConfig;
  "proposal-detail": ProposalDetailConfig;
  "proposal-timeline": ProposalTimelineConfig;
  // property-value and property-group merged into entity-properties
  // Workflows / automations
  "workflow-list": Record<string, unknown>;
  "automation-detail": Record<string, unknown>;
  "automation-flow": Record<string, unknown>;
  "automation-status": Record<string, unknown>;
  "command-detail": Record<string, unknown>;
  "trigger-button": Record<string, unknown>;
  "run-history": Record<string, unknown>;
  // Brand Library
  "brand-library-summary": BrandLibrarySummaryConfig;
  "brand-token-preview": BrandTokenPreviewConfig;
  "brand-template-picker": BrandTemplatePickerConfig;
  // Welcome / onboarding
  welcome: Record<string, unknown>;
  "welcome-header": Record<string, unknown>;
  // Proactive intelligence
  "proactive-insight": Record<string, unknown>;
  "proactive-feed": Record<string, unknown>;
  "notifications-feed": { limit?: number };
  "agent-chat-recent": { limit?: number };
  // AI Action Cards
  "ai-proposed-action": AIProposedActionConfig;
  "ai-doc-proposal": AIDocProposalConfig;
  "ai-workspace-proposal": AIWorkspaceProposalConfig;
  // Focus Sessions
  "active-sessions": ActiveSessionsConfig;
  "session-goal-bar": SessionGoalBarConfig;
  // Agent runs
  "agent-runs": AgentRunsConfig;
  // Agent spend
  "agent-spend": AgentSpendConfig;
}

// ─── View config interfaces ───────────────────────────────────────────────────

export interface TableViewConfig {
  hiddenColumns?: string[];
  columnWidths?: Record<string, number>;
  columnOrder?: string[];
  pinnedColumns?: string[];
  defaultSort?: { field: string; direction: "asc" | "desc" };
  rowHeight?: "compact" | "default" | "comfortable";
  stickyColumns?: number;
}

/**
 * A live, high-density entity projection. The configuration is deliberately
 * presentation-only: entities and properties remain the canonical data model.
 */
export interface SheetViewConfig {
  hiddenColumns?: string[];
  columnWidths?: Record<string, number>;
  columnOrder?: string[];
  frozenColumnIds?: string[];
  density?: "compact" | "normal" | "spacious";
  showRowNumbers?: boolean;
}

export interface KanbanViewConfig {
  /** Property to group columns by */
  groupByField: string;
  /** Properties to show on cards */
  cardFields?: string[];
  cardSize?: "sm" | "md" | "lg";
}

export interface ListViewConfig {
  groupByField?: string;
  cardFields?: string[];
}

export interface GridViewConfig {
  cardFields?: string[];
  cardSize?: "sm" | "md" | "lg";
}

export interface GalleryViewConfig {
  /** Property containing image URL */
  imageField: string;
  /** Properties to show below the image */
  cardFields?: string[];
}

export interface CalendarViewConfig {
  /** Property containing the start date */
  dateField: string;
  endDateField?: string;
  colorField?: string;
}

export interface MatrixViewConfig {
  /** Property for columns (X axis) — must be enum-constrained */
  xField: string;
  /** Property for rows (Y axis) — must be enum-constrained */
  yField: string;
  /** Properties to show on entity cards within cells */
  cardFields?: string[];
  /** Card size */
  cardSize?: "sm" | "md" | "lg";
}

export interface MasonryViewConfig {
  /** Column width in px (default: 280) */
  columnWidth?: number;
  /** Sort field (default: "createdAt") */
  sortField?: string;
  /** Sort direction (default: "desc") */
  sortDirection?: "asc" | "desc";
}

export interface GanttViewConfig {
  dateField: string;
  endDateField?: string;
  groupByField?: string;
}

export interface TimelineViewConfig {
  timeField: string;
  /** "vertical" = rich event stream with date groups; "horizontal" = dot-spine compact */
  orientation?: "vertical" | "horizontal";
  groupByField?: string;
}

export interface GraphViewConfig {
  presentation?: "galaxy" | "network";
  layout?: "kind" | "force" | "tree" | "radial" | "dagre";
  showRelations?: boolean;
  nodeColorField?: string;
  edgeLabelField?: string;
}

export interface FlowViewConfig {
  layout?: "dagre" | "elk" | "force";
}

export interface BentoViewConfig {
  layout?: "bento" | "grid" | "flow";
  breakpoints?: Record<string, unknown>;
  blocks?: unknown[];
}

export type EmptyViewConfig = Record<string, never>;

// ─── Discriminated union: view type → config ─────────────────────────────────

export interface ViewConfigByType {
  sheet: SheetViewConfig;
  table: TableViewConfig;
  list: ListViewConfig;
  grid: GridViewConfig;
  gallery: GalleryViewConfig;
  kanban: KanbanViewConfig;
  matrix: MatrixViewConfig;
  masonry: MasonryViewConfig;
  calendar: CalendarViewConfig;
  gantt: GanttViewConfig;
  timeline: TimelineViewConfig;
  graph: GraphViewConfig;
  flow: FlowViewConfig;
  branch_tree: EmptyViewConfig;
  bento: BentoViewConfig;
  whiteboard: EmptyViewConfig;
  mindmap: EmptyViewConfig;
  map: { locationField?: string; showRoutes?: boolean };
}

// ─── Capability metadata ──────────────────────────────────────────────────────

export type WidgetCategory =
  | "core"
  | "data"
  | "charts"
  | "communication"
  | "ai"
  | "app-specific"
  | "entity"
  | "content"
  | "governance"
  | "productivity";

/**
 * Semantic intent section for the BentoBlockPicker.
 * Used as {@link WidgetCapabilityDef.semanticSection}.
 */
export type SemanticSectionKey =
  | "start-here" // High-value quick-add: Greeting, Search, Inbox
  | "track-monitor" // KPIs and progress: Stat Card, Gauge, Ring
  | "browse-explore" // Navigating data: Entity List, Gallery, Views
  | "visualize" // Charts — data-driven: chart-* widgets
  | "collaborate" // Channels and AI: AI Chat, Channel View
  | "automate-govern" // AI actions and governance: Proposals, Automations
  | "layout-compose"; // Structure: Section Header, Link Grid, Iframe

export interface WidgetCapabilityDef {
  /** Registry key used in bento block widgetType */
  key: WidgetTypeKey;
  name: string;
  description: string;
  icon: string;
  category: WidgetCategory;
  displayModes: DisplayMode[];
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  /**
   * Config fields as a flat schema for AI generation + settings UI.
   *
   * Typed as {@link CellSettingsField} (the superset) so widget definitions can
   * declare the richer picker kinds (`profile`, `property`, `icon`, `variant`,
   * …) directly in the catalog. Plain {@link WidgetConfigField} entries remain
   * valid because every `WidgetConfigField` is assignable to `CellSettingsField`.
   */
  configSchema: CellSettingsField[];
  /** Whether this widget requires a workspace connection */
  requiresWorkspace?: boolean;
  /** Whether this is an alias for another widget key */
  aliasOf?: WidgetTypeKey;
  /**
   * Hide this widget from the add-block picker catalog while keeping its key in
   * the manifest (so its typeKey stays frozen and existing bento blocks keep
   * rendering). Used for stubs / unpublished widgets, e.g. `map-widget` until
   * `@synap-core/map-view` ships.
   */
  hiddenFromPicker?: boolean;
  /**
   * Semantic intent section for the BentoBlockPicker (replaces the raw `category`
   * grouping in the UI). Undefined = falls back to category mapping.
   */
  semanticSection?: SemanticSectionKey;
  /**
   * When true, clicking this widget in the BentoBlockPicker adds it directly to
   * the grid without showing the guided setup wizard. Use for self-contained
   * widgets that have no required config fields (e.g. Greeting, Search, Feed).
   * Defaults to false (wizard is shown for widgets with configSchema).
   * @deprecated Use `requiresSetup: true` on data-driven widgets instead. Both
   * flags are checked — `requiresSetup` takes precedence; `directAdd` remains
   * for backward compatibility.
   */
  directAdd?: true;
  /**
   * When true, opening this widget in the BentoBlockPicker triggers the guided
   * setup wizard instead of immediately dropping the block with defaults.
   * Opt-in: leave undefined or false for simple widgets (layout, static display).
   * Takes precedence over `directAdd`.
   */
  requiresSetup?: boolean;
  /** Pre-built config presets for quick widget creation */
  presets?: WidgetPreset[];
  /**
   * External network origins a *generated/framed* cell (ViewFrame / iframe cell)
   * is permitted to reach, e.g. `['https://api.example.com', 'wss://stream.x']`.
   *
   * SECURITY MODEL (default-deny, origin-allowlist): a cell with NO declared
   * `externalHosts` reaches no arbitrary origin — the composed CSP is
   * `connect-src blob: https://esm.sh` (esm.sh is always present because the
   * frame loads its module graph from it), so the only data paths are the host
   * bridge (onQuery/onMutate, proposal-gated) and the module CDN. Declaring
   * hosts here ADDS exactly those origins to the frame's `connect-src`/
   * `img-src`; the composer in `ViewFrame.tsx` drops malformed entries.
   *
   * ⚠️ There is NO install-time approval step for this field, and nothing
   * persists it: `install-cell-from-definition.ts` does not thread it, so a
   * package-borne cell cannot declare egress at all today — only a cell config
   * written directly can. (This docstring previously claimed both an
   * install-time approval and a `connect-src 'none'` default; neither was ever
   * true. The SKILL half of the same problem is fixed —
   * `CapabilitySkillDef.metadata.allowedHosts` is threaded end-to-end and
   * enforced by the skill sandbox.)
   *
   * ⚠️ And the config path that DOES reach it is unvalidated: the live producer
   * is `BrowserViewFrameCell.tsx`, which spreads `{...config, ...cellProps}`, so
   * anything able to write a block config can widen the frame's CSP — no
   * `configSchema` declares this field, so nothing narrows what may be written.
   * That is contained by ACCIDENT (no package can author it yet), not by a
   * control. Before cells become publishable by third parties, this field needs
   * either a schema that constrains it or removal from the config spread — and
   * note that widening egress is NOT the channel that actually leaks today:
   * sub-frame navigation is (CSP fetch-directives do not cover it, and
   * `navigate-to` was dropped from the spec). See
   * `.wave2-reports/plan-cell-egress.md`.
   *
   * This is a declaration only — it does NOT grant credentials. The frame still
   * receives no pod URL / token / API key. Origins must be `http(s)://` or
   * `wss://`; malformed entries are dropped by the CSP composer in ViewFrame.
   *
   * Only meaningful for frame-runtime cells; ignored for native-component cells.
   */
  externalHosts?: string[];
  /**
   * WHERE this cell may render. `inline` = embeddable in a document
   * (`:::synap-cell{cellKey}`). Omitted ⇒ {@link DEFAULT_WIDGET_PLACEMENTS}
   * (every catalog widget is document-embeddable — decision D-embed); set it
   * only to NARROW a widget. Read through `placementsFor()`, never directly.
   */
  placements?: Placement[];
  /**
   * How the cell gets its data, and which binding a new embed should use.
   * Omitted ⇒ `{ supports: ["none"], default: "none" }` (a self-contained
   * widget). Declare ONLY what the cell's component actually renders today —
   * a binding the renderer ignores is a field declared on the wire and
   * populated by nobody. Read through `dataBindingFor()`.
   */
  dataBinding?: RenderableDataBinding;
  /**
   * Markdown fallback template — what relay, exports, other agents and a
   * missing-referent web embed show instead of the live cell. Data, not code,
   * so it renders without React (`renderRenderableFallback`). Placeholders:
   * `{name}` (this entry's name) and `{props.<key>}` (an embed prop). Omitted ⇒
   * {@link DEFAULT_FALLBACK_TEMPLATE}.
   */
  fallback?: string;
  /**
   * AI-facing guidance: when to pick this cell and the config gotchas an agent
   * hits (folded in from the backend's former compose catalog `notes`).
   */
  aiHint?: string;
  /**
   * Config keys an agent MUST set for the cell to render. Omitted ⇒ derived
   * from `configSchema` fields marked `required: true`. Read through
   * `requiredConfigFor()`. An EXPLICIT `[]` asserts "renders with no config".
   */
  requiredConfig?: string[];
  /**
   * The built-in package (`SynapPackage.id` in `@synap-core/cells`) that
   * registers this cell. Its package's capability list is DERIVED from this
   * field — never hand-listed. Omitted ⇒ the cell belongs to no toggleable
   * package (registered by the always-on core).
   */
  package?: BuiltinPackageId;
}

/**
 * The built-in package ids a catalog entry may belong to (mirrors
 * `BUILTIN_PACKAGES` in `@synap-core/cells`; that module types its ids with
 * this union so the two cannot drift).
 */
export const BUILTIN_PACKAGE_IDS = [
  "synap.core-runtime",
  "synap.core-widgets",
  "synap.entity-views",
  "synap.channels",
  "synap.ai-chat",
  "synap.proposals",
  "synap.views",
  "synap.bento-widgets",
  "synap.proactive-ai",
  "synap.workflows",
  "synap.brand-library",
] as const;
export type BuiltinPackageId = (typeof BUILTIN_PACKAGE_IDS)[number];

/**
 * Data binding of an embedded renderable (decision D2).
 *  - `query`    — live: reads its data through a query (profileSlug / viewId)
 *  - `inline`   — snapshot: the data travels in the embed's JSON props block
 *  - `instance` — a saved cell instance (`instanceId`)
 *  - `none`     — self-contained; no data binding
 */
export const DATA_BINDINGS = ["query", "inline", "instance", "none"] as const;
export type DataBinding = (typeof DATA_BINDINGS)[number];

export interface RenderableDataBinding {
  supports: DataBinding[];
  /** The binding a NEW embed uses when the author does not choose. */
  default: DataBinding;
  /**
   * The shape of the data the cell DRAWS (charts). A live query is shaped into
   * it, and a snapshot's `props.data` must match it (`parseChartData`).
   * Required when `supports` includes `inline` — a snapshot with no declared
   * shape could not be validated.
   */
  dataShape?: ChartDataShape;
}

/**
 * How a renderable is written in markdown: a directive (`:::synap-cell{…}`)
 * or a fenced code block (` ```<language> `). Widgets are always directives.
 */
export const RENDERABLE_FORMS = ["directive", "fence"] as const;
export type RenderableForm = (typeof RENDERABLE_FORMS)[number];

/**
 * A named, pre-filled config for a widget — surfaced as its own card in the
 * add-block picker. Picking a preset adds a block with the PARENT widget's key
 * and `config = { ...schemaDefaults, ...preset.config }`. Presets are how a
 * generic widget (e.g. `view`, `stat-card`) covers the use-cases that used to be
 * dedicated widget TYPES, without inflating the frozen type count.
 */
export interface WidgetPreset {
  label: string;
  icon?: string;
  /** Optional one-line description shown in the picker tooltip. */
  description?: string;
  config: Record<string, unknown>;
}

export interface WidgetConfigField {
  key: string;
  label: string;
  type:
    "string" | "number" | "boolean" | "select" | "color" | "object" | "array";
  required?: boolean;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
  description?: string;
}

/**
 * A cell settings field — the generalized superset of {@link WidgetConfigField}
 * used by the universal cell-settings panel.
 *
 * It WIDENS the `type` union with richer picker kinds — reference pickers
 * (`entity`, `profile`, `property`, `relation-type`, `view`, `channel`,
 * `automation`, `command`) plus value pickers (`date`, `color`, `icon`,
 * `variant`) — and adds optional `group`/`groupIcon` (for sectioned rendering),
 * `dependsOn` (sibling-field cascading), plus `constraints` (validation bounds).
 * The base interface cannot be extended directly because the wider `type` union
 * is incompatible — so we `Omit` and re-add `type`. As a result every
 * `WidgetConfigField` remains assignable to `CellSettingsField`.
 */
export type CellSettingsField = Omit<WidgetConfigField, "type"> & {
  type:
    | WidgetConfigField["type"]
    | "date"
    | "url"
    | "entity"
    | "profile"
    | "property"
    | "relation-type"
    | "view"
    | "channel"
    | "automation"
    | "command"
    | "icon"
    | "variant"
    // ── Composite editors (close the free-text gaps) ──
    /**
     * `"list"` → an ARRAY-OF-OBJECTS editor (RepeaterField): a reorderable list
     * of rows, each editing one object via {@link itemSchema} (a nested
     * `CellSettingsField[]` rendered with the same field dispatch). Value is
     * `Record<string, unknown>[]`. Use for `link-grid` links and any
     * structured list — replaces the JSON/textarea fallback.
     */
    | "list"
    /**
     * `"filter"` → a condition-builder editor (FilterBuilderField) for a
     * property filter. Value shape:
     * `{ join: "and" | "or"; conditions: Array<{ property; operator; value }> }`.
     * Use for the `filter` config fields on entity-list / stat-card / gallery —
     * replaces the raw `{ "status": "active" }` JSON textarea.
     */
    | "filter";
  /**
   * For `type: "array"` fields: the kind of each item, which selects a precise
   * MULTI-ref picker instead of the free-text fallback.
   *  - `"property"` → multi-property picker (cascades on a sibling `profile`
   *    field via {@link dependsOn}; loads from `CellData.listProperties`)
   *  - `"entity"` → multi-entity picker (async search via
   *    `CellData.searchEntities`, optionally scoped via {@link dependsOn})
   *  - `"string"` / omitted → free-form list field (text fallback, preserved
   *    for genuinely free-form arrays like object lists)
   * Ignored unless `type === "array"`.
   */
  itemType?: "property" | "entity" | "profile" | "string";
  /**
   * For `type: "list"` fields ONLY: the per-row sub-fields. Each row of the
   * RepeaterField renders these as a mini form (recursive — they are full
   * {@link CellSettingsField}s dispatched by the same renderer). Self-referential
   * so a row may in turn declare nested pickers (`icon`, `property`, …).
   */
  itemSchema?: CellSettingsField[];
  /** Section label for grouped rendering */
  group?: string;
  /** Lucide icon name for the group */
  groupIcon?: string;
  /**
   * Key of a SIBLING field whose value scopes this one. A cascading reference:
   * a `property` field cascades on the chosen `profile` field, an `entity` field
   * is scoped by a `profile` field. When the depended-on value is empty, a
   * cascading field renders a disabled "select … first" state.
   */
  dependsOn?: string;
  /** Optional validation bounds */
  constraints?: {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
  /**
   * Makes this field required only when a sibling field matches a specific value.
   * Used for conditional validation (e.g. groupBy required when chartType=donut).
   * The settings panel renders an inline warning when the condition is met but
   * the field is empty.
   */
  requiredWhen?: { key: string; value: unknown };
  /**
   * Written by the system or the author's markdown, never hand-edited in the
   * settings panel (a chart snapshot's `data` / `capturedAt`, written by
   * "Freeze"). Still declared, so agents and validators know the key.
   */
  settingsHidden?: true;
  /**
   * The AI-facing JSON Schema of the value when `type` cannot say it (a chart
   * snapshot's `data` is an array of objects or a number, not a free object).
   */
  jsonSchema?: Record<string, unknown>;
};

export interface ViewCapabilityDef {
  /** View type string as stored on the view record */
  key: ViewTypeKey;
  name: string;
  description: string;
  icon: string;
  /** Data category: structured = uses entity query, canvas = freeform */
  category: "structured" | "canvas" | "special";
  /**
   * Semantic family — what dimension of the data this view projects onto.
   * Drives the family-grouped picker and the within-/cross-family interchange
   * logic. Orthogonal to `category`.
   */
  family: ViewFamily;
  /** Whether this view is fully implemented in the renderer */
  implemented: boolean;
  /**
   * Whether this view is a LENS on an entity query — i.e. "see this same entity
   * set projected a different way". Lenses are interchangeable in the family
   * view switcher (within-family siblings + the ⋯ cross-family menu).
   *
   * `false` marks a standalone surface that is NOT a lens on an entity set:
   * branch_tree (an AI-conversation fork explorer, channel-specific), bento
   * (a freeform widget dashboard), whiteboard (an infinite freeform canvas), and
   * mindmap (a freeform outline, not a query projection). These keep their defs
   * + adapters and render where they belong (channels, dashboards) but are
   * excluded from the entity-view switcher.
   *
   * Defaults to `true` when omitted — most views are lenses.
   */
  entityLens?: boolean;
  /** Config fields for AI generation + settings UI */
  configSchema: ViewConfigField[];
  /** Required config fields that must be set for the view to work */
  requiredConfig?: string[];
  /** AI-facing guidance: when to pick this view type. */
  aiHint?: string;
}

export interface ViewConfigField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select" | "color" | "object";
  required?: boolean;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
  description?: string;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

export interface CapabilitiesManifest {
  /** Manifest content/build version (semver string, e.g. "1.0.0"). NOT the structural contract version — see schemaVersion. */
  version: string;
  /**
   * Structural CONTRACT version of the manifest shape. Bump ONLY when the
   * manifest's structural shape changes (fields added/removed/retyped on the
   * manifest envelope or its entry shapes) — NOT for content edits like adding
   * a widget/view. Consumers gate parsing/compat on this integer.
   */
  schemaVersion: number;
  /** ISO timestamp of generation */
  generatedAt: string;
  widgets: WidgetCapabilityDef[];
  views: ViewCapabilityDef[];
  /** Convenience index: widgetKey → def */
  widgetsByKey: Record<string, WidgetCapabilityDef>;
  /** Convenience index: viewKey → def */
  viewsByKey: Record<string, ViewCapabilityDef>;
}

// ─── Template authoring helpers ───────────────────────────────────────────────

/** Type-safe bento block definition for use in workspace templates. */
export interface BentoBlockDef {
  id?: string;
  /** Widget type key */
  widgetType: WidgetTypeKey;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Widget-specific config */
  config?: Partial<WidgetConfigByType[WidgetTypeKey]>;
}

/** Type-safe view definition for use in workspace templates. */
export interface TemplateViewDef {
  name: string;
  type: ViewTypeKey;
  /** For bento views */
  blocks?: BentoBlockDef[];
  /** For structured views */
  config?: Partial<ViewConfigByType[ViewTypeKey]>;
  /** Profile slug this view is scoped to */
  scopeProfileSlug?: string;
}
