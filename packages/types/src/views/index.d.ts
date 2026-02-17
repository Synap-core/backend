/**
 * View Types
 *
 * Single source of truth for all view-related types.
 * Consolidated from multiple files for clarity.
 */
export type { View, NewView } from "./schema.js";
export * from "./types.js";
export * from "./schemas.js";
export * from "./query.js";
export * from "./config.js";
export * from "./config-schemas.js";
export * from "./config-types.js";
export * from "./view-type-enum.js";
/**
 * View types - categorized by rendering approach
 */
export type ViewType = "whiteboard" | "table" | "kanban" | "list" | "grid" | "gallery" | "calendar" | "gantt" | "timeline" | "mindmap" | "graph" | "bento";
import type { EntityQuery } from "./query.js";
export interface CreateViewInput {
    workspaceId?: string;
    type: ViewType;
    name: string;
    description?: string;
    scopeProfileIds?: string[];
    scopeMode?: "explicit" | "observed";
    query?: EntityQuery;
    config?: Record<string, unknown>;
    embeddedViewIds?: string[];
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
//# sourceMappingURL=index.d.ts.map