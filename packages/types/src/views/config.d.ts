/**
 * View Configuration Types
 *
 * Discriminated union for view configurations.
 */
import type { EntityQuery, EntityFilter } from "./query.js";
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
    colors?: Record<string, string>;
    format?: string;
    relative?: boolean;
    wrap?: boolean;
    lines?: number;
    precision?: number;
    currency?: string;
    align?: "left" | "center" | "right";
    icon?: string;
  };
}
export interface ColumnConfig {
  id: string;
  field: string;
  width?: number;
  visible?: boolean;
  title?: string;
  display?: ColumnDisplayConfig;
}
export interface FormattingRule {
  id: string;
  name?: string;
  target: "row" | "cell" | "card";
  filter: EntityFilter;
  style: {
    color?: string;
    backgroundColor?: string;
    fontWeight?: "bold" | "normal";
    fontStyle?: "italic" | "normal";
    strikeThrough?: boolean;
    icon?: string;
  };
}
export interface RenderSettings {
  rowHeight?: "compact" | "default" | "tall";
  formatting?: FormattingRule[];
  columns?: ColumnConfig[];
  groupByField?: string;
  cardFields?: string[];
  cardSettings?: {
    coverField?: string;
    showAvatars?: boolean;
    visibleFields?: string[];
    colorField?: string;
  };
  dateField?: string;
  endDateField?: string;
  colorField?: string;
  layout?: "force" | "hierarchical" | "circular";
  nodeColorField?: string;
  edgeLabelField?: string;
}
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
export interface StructuredViewConfig {
  category: "structured";
  query: EntityQuery;
  render?: RenderSettings;
}
export interface CanvasViewConfig {
  category: "canvas";
}
/**
 * Discriminated union of all view configuration types
 */
export type ViewConfig = StructuredViewConfig | CanvasViewConfig;
//# sourceMappingURL=config.d.ts.map
