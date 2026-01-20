/**
 * View Types
 *
 * Single source of truth for all view-related types.
 * Consolidated from multiple files for clarity.
 */

// Direct re-exports from schema definition (pure types)
export type { View, NewView } from "./schema.js";

// =============================================================================
// Core Types
// =============================================================================

export * from "./types.js";
export * from "./schemas.js";
export * from "./query.js";
export * from "./config.js";

// =============================================================================
// View Type Enum
// =============================================================================

/**
 * View types - categorized by rendering approach
 */
export type ViewType =
  | "whiteboard"
  | "table"
  | "kanban"
  | "list"
  | "grid"
  | "gallery"
  | "calendar"
  | "gantt"
  | "timeline"
  | "mindmap"
  | "graph";

// =============================================================================
// API Input Types
// =============================================================================

import type { ViewConfig } from "./config.js";

export interface CreateViewInput {
  workspaceId?: string;
  type: ViewType;
  name: string;
  description?: string;
  config?: ViewConfig; // NEW: Replaces initialContent/tableConfig
}

export interface UpdateViewInput {
  name?: string;
  description?: string;
  config?: Partial<ViewConfig>;
}
