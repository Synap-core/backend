/**
 * View Configuration Types
 *
 * Discriminated union for view configurations.
 */

import type { EntityQuery, EntityFilter } from "./query.js";

// =============================================================================
// Render Configuration
// =============================================================================

export interface ColumnDisplayConfig {
  type:
    | "text"
    | "badge"
    | "date"
    | "user"
    | "url"
    | "boolean"
    | "progress"
    | "rating"
    | "image"
    | "file";
  params?: {
    // Badge params
    colors?: Record<string, string>; // { "Doing": "blue" }

    // Date params
    format?: string; // e.g. 'MMM DD, YYYY'
    relative?: boolean; // '2 days ago'

    // Text params
    wrap?: boolean;
    lines?: number;

    // Number params
    precision?: number;
    currency?: string;

    // General
    align?: "left" | "center" | "right";
    icon?: string;
  };
}

export interface ColumnConfig {
  id: string;
  field: string;
  width?: number;
  visible?: boolean;
  title?: string; // Override field name
  display?: ColumnDisplayConfig;
}

export interface FormattingRule {
  id: string;
  name?: string;
  target: "row" | "cell" | "card";
  filter: EntityFilter; // If entity matches this filter...
  style: {
    color?: string;
    backgroundColor?: string;
    fontWeight?: "bold" | "normal";
    fontStyle?: "italic" | "normal";
    strikeThrough?: boolean;
    icon?: string;
  };
}

// =============================================================================
// Render Settings
// =============================================================================

/**
 * The composable, coordinate-based Sheet contract. Content references remain
 * live: views, entities and cells are IDs/keys, never copied payloads.
 */
/**
 * Persisted renderer choice for a Sheet. `canvas` is intentionally retained as
 * an input compatibility alias for Sheets saved before the composition renderer
 * had a canonical name. New writes must use `composition`.
 */
export type SheetSurface = "grid" | "composition" | "table" | "canvas";

/** The renderer values emitted by new Sheet clients. */
export type CanonicalSheetSurface = Exclude<SheetSurface, "canvas">;

export function normalizeSheetSurface(
  surface: SheetSurface | undefined
): CanonicalSheetSurface {
  if (surface === "canvas") return "composition";
  return surface ?? "grid";
}

/**
 * A zero-indexed, inclusive rectangular range in the Sheet's canonical grid.
 * Every table and embedded block occupies one of these ranges; renderers may
 * differ, but they must all use the same row/column coordinates.
 */
export interface SheetGridRange {
  start: { row: number; column: number };
  end: { row: number; column: number };
}

/**
 * Persisted global Sheet axis dimensions. Keys are zero-indexed logical grid
 * coordinates (serialised as JSON object keys), never a property ID or a
 * table-local index.
 */
export interface SheetGridDimensions {
  columnWidths?: Record<number, number>;
  rowHeights?: Record<number, number>;
}

export interface SheetCanvasPosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SheetCanvasBlockBase {
  id: string;
  title?: string;
  /** Canonical placement for all new Sheet blocks. */
  range?: SheetGridRange;
  /**
   * Legacy canvas placement. Kept while saved Sheets are migrated lazily. A
   * block must contain either `range` or `position`; new writers use `range`.
   */
  position?: SheetCanvasPosition;
}

export interface SheetTableBlock extends SheetCanvasBlockBase {
  kind: "table";
  source: "current-view";
}

export interface SheetViewBlock extends SheetCanvasBlockBase {
  kind: "view";
  viewId: string;
}

export interface SheetEntityBlock extends SheetCanvasBlockBase {
  kind: "entity";
  entityId: string;
}

export interface SheetCellBlock extends SheetCanvasBlockBase {
  kind: "cell";
  cellKey: string;
  props?: Record<string, unknown>;
}

export interface SheetNoteBlock extends SheetCanvasBlockBase {
  kind: "note";
  content: string;
}

export type SheetCanvasBlock =
  | SheetTableBlock
  | SheetViewBlock
  | SheetEntityBlock
  | SheetCellBlock
  | SheetNoteBlock;

export interface RenderSettings {
  // Common
  rowHeight?: "compact" | "default" | "tall";
  formatting?: FormattingRule[];

  // Table/List settings
  columns?: ColumnConfig[];

  // Sheet presentation and canvas composition
  sheetSurface?: SheetSurface;
  sheetBlocks?: SheetCanvasBlock[];
  columnOrder?: string[];
  hiddenColumns?: string[];
  /** Legacy, table-property width preferences. */
  columnWidths?: Record<string, number>;
  /** Sheet-owned global row/column geometry. */
  sheetGridDimensions?: SheetGridDimensions;
  density?: "compact" | "normal" | "spacious";
  frozenColumnIds?: string[];
  showRowNumbers?: boolean;

  // Kanban settings
  groupByField?: string;
  cardFields?: string[];
  cardSettings?: {
    coverField?: string;
    showAvatars?: boolean;
    visibleFields?: string[];
    colorField?: string;
  };
  /** Persisted kanban columns. When present overrides enum-derived columns. */
  kanbanColumns?: Array<{
    id: string;
    value: string;
    label: string;
    order: number;
    color?: string;
    limit?: number | null;
    visible?: boolean;
  }>;

  // Calendar settings
  dateField?: string;
  endDateField?: string;
  colorField?: string;

  // Graph settings
  layout?: "force" | "hierarchical" | "circular";
  nodeColorField?: string;
  edgeLabelField?: string;
}

// =============================================================================
// View Metadata
// =============================================================================

export interface ViewMetadata {
  /** View configuration (query + render) */
  config?: ViewConfig;

  /** Manual entity ordering (for drag-and-drop) */
  entityOrders?: Record<string, number>;

  /** Quick access metadata */
  entityCount?: number;
  createdBy?: string;
  lastEditedBy?: string;
}

// =============================================================================
// View Config Union
// =============================================================================

export interface StructuredViewConfig {
  category: "structured";
  query: EntityQuery;
  render?: RenderSettings;
}

export interface CanvasViewConfig {
  category: "canvas";
  // Canvas views store content in documents table
}

/**
 * Discriminated union of all view configuration types
 */
export type ViewConfig = StructuredViewConfig | CanvasViewConfig;
