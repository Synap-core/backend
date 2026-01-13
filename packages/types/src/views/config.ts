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

export interface RenderSettings {
  // Common
  rowHeight?: "compact" | "default" | "tall";
  formatting?: FormattingRule[];

  // Table/List settings
  columns?: ColumnConfig[];

  // Kanban settings
  groupByField?: string;
  cardFields?: string[];
  cardSettings?: {
    coverField?: string;
    showAvatars?: boolean;
    visibleFields?: string[];
    colorField?: string;
  };

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
