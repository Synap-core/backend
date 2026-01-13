/**
 * View Content Types
 *
 * Defines the discriminated union for view content based on category.
 * Categories determine the structure and purpose of view content.
 */

// =============================================================================
// View Categories
// =============================================================================

/**
 * View category determines content structure and rendering approach
 * - structured: Query-based views with interchangeable layouts (table, kanban, graph, etc.)
 * - canvas: Freeform drawing views (whiteboard, mindmap)
 */
export type ViewCategory = "structured" | "canvas";

/**
 * View type enum (imported from index.ts)
 */
import type { ViewType } from "./index.js";

/**
 * Map view types to their categories
 */
export const VIEW_TYPE_CATEGORIES: Record<ViewType, ViewCategory> = {
  // Structured (query-based, interchangeable layouts)
  table: "structured",
  kanban: "structured",
  list: "structured",
  grid: "structured",
  gallery: "structured",
  calendar: "structured",
  gantt: "structured",
  timeline: "structured",
  graph: "structured", // Graph is also query-based!

  // Canvas (freeform drawing)
  whiteboard: "canvas",
  mindmap: "canvas",
};

/**
 * Get category for a view type
 *
 * @param type - The view type
 * @returns The category of the view type
 */
export function getViewCategory(type: ViewType): ViewCategory {
  return VIEW_TYPE_CATEGORIES[type];
}

// ... imports
import { type EntityQuery } from "./query.js";

// ... (keep View Categories)

// Remove EntityQuery definitions (imported)

// =============================================================================
// Structured View Config
// =============================================================================

/**
 * Layout modes for structured views
 * All are query-based but render differently
 */
export type StructuredLayout =
  | "table"
  | "kanban"
  | "list"
  | "grid"
  | "gallery"
  | "calendar"
  | "gantt"
  | "timeline"
  | "graph";

/**
 * Kanban column configuration
 */
export interface KanbanColumn {
  id: string;
  value: string;
  label: string;
  order: number;
  color?: string;
  limit?: number; // WIP limit
}

/**
 * Configuration for structured views
 * Renamed to ViewRenderConfig to avoid conflict with config.ts StructuredViewConfig
 */
export interface ViewRenderConfig {
  /** Layout mode (determines how entities are rendered) */
  layout: StructuredLayout;

  // Common to all layouts (except graph)
  /** Column definitions (re-uses existing types) */
  columns?: any[]; // Type imported from index.ts

  /** Filter rules */
  filters?: any[];

  /** Sort rules */
  sorts?: any[];

  /** Field to group by (for kanban, list views) */
  groupByColumnId?: string;

  // Layout-specific configurations
  /** Kanban column definitions */
  kanbanColumns?: KanbanColumn[];

  /** Date field for calendar view */
  calendarDateField?: string;

  /** Time field for timeline view */
  timelineTimeField?: string;

  /** Graph layout algorithm */
  graphLayout?: "force" | "hierarchical" | "circular";

  /** Relationship types to show in graph */
  graphRelationshipTypes?: string[];
}

// =============================================================================
// View Content (Discriminated Union)
// =============================================================================

/**
 * Structured view content
 * Used for table, kanban, list, grid, graph, etc.
 */
export interface StructuredViewContent {
  /** Schema version for migrations */
  version: 1;

  /** Category discriminator */
  category: "structured";

  /** Entity query (what to show) */
  query: EntityQuery;

  /** Display configuration (how to show it) */
  config: ViewRenderConfig;
}

/**
 * Canvas view content
 * Used for whiteboard, mindmap, etc.
 */
export interface CanvasViewContent {
  /** Schema version for migrations */
  version: 1;

  /** Category discriminator */
  category: "canvas";

  /** Canvas elements (Tldraw shapes, etc.) */
  elements: unknown[];

  /** Entity IDs embedded in the canvas */
  embeddedEntities?: string[];
}

/**
 * Discriminated union of all view content types
 * Use the category field to determine the content structure
 */
export type ViewContent = StructuredViewContent | CanvasViewContent;

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard: Check if content is structured
 */
export function isStructuredContent(
  content: ViewContent,
): content is StructuredViewContent {
  return content.category === "structured";
}

/**
 * Type guard: Check if content is canvas
 */
export function isCanvasContent(
  content: ViewContent,
): content is CanvasViewContent {
  return content.category === "canvas";
}

/**
 * Get content type for view type
 */
export function getContentCategoryForViewType(type: ViewType): ViewCategory {
  return VIEW_TYPE_CATEGORIES[type];
}
