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
export * from "./config-schemas.js";
export * from "./config-types.js";
export * from "./view-type-enum.js";

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
  | "matrix"
  | "masonry"
  | "list"
  | "grid"
  | "gallery"
  | "calendar"
  | "gantt"
  | "timeline"
  | "mindmap"
  | "graph"
  | "flow"
  | "bento"
  | "branch_tree";

// =============================================================================
// API Input Types
// =============================================================================

import type { EntityQuery } from "./query.js";

export interface CreateViewInput {
  workspaceId?: string;
  type: string;
  name: string;
  description?: string;
  // NEW: Scope profiles (required for structured views)
  scopeProfileIds?: string[];
  scopeMode?: "explicit" | "observed";
  // NEW: Consolidated query
  query?: EntityQuery;
  // NEW: Render config (overrides only)
  config?: Record<string, unknown>;
  // NEW: Embedded view IDs (for composite views)
  embeddedViewIds?: string[];
  // Canvas views: initialContent (for whiteboard, mindmap)
  initialContent?: unknown;
}

export interface UpdateViewInput {
  name?: string;
  description?: string;
  scopeProfileIds?: string[];
  scopeMode?: "explicit" | "observed";
  query?: EntityQuery;
  config?: Record<string, unknown>;
  embeddedViewIds?: string[];
  schemaSnapshot?: Record<string, unknown>;
  snapshotUpdatedAt?: Date;
}
