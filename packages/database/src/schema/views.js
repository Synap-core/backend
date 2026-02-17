/**
 * Views Schema - Extensible view system
 *
 * Supports multiple view types:
 * - whiteboard (visual canvas with entities)
 * - timeline (chronological view)
 * - kanban (board view)
 * - table (spreadsheet view)
 * - mindmap (hierarchical view)
 */
import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { documents } from "./documents.js";
import { profiles } from "./profiles.js";
export const views = pgTable("views", {
    id: uuid("id").defaultRandom().primaryKey(),
    // Ownership & Context
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
        onDelete: "cascade",
    }),
    userId: text("user_id").notNull(), // Creator
    // Projects: Use relations table (if view is linked to entity) or remove projectIds
    // View type (extensible)
    type: text("type").notNull(),
    // 'whiteboard' | 'timeline' | 'kanban' | 'table' | 'mindmap' | 'graph'
    // Category (computed from type)
    // 'structured' = query-based views (table, kanban, graph, etc.)
    // 'canvas' = freeform views (whiteboard, mindmap)
    category: text("category").notNull(),
    // Metadata
    name: text("name").notNull(),
    description: text("description"),
    // NEW: Declared schema scope (stable anchor for deterministic defaults)
    scopeProfileIds: uuid("scope_profile_ids")
        .array()
        .references(() => profiles.id, { onDelete: "cascade" }), // FK array to profiles
    scopeMode: text("scope_mode"), // 'explicit' | 'observed' (optional)
    // NEW: Consolidated query (dynamic - filters/sorts/search)
    query: jsonb("query").default("{}"), // EntityQuery: { filters, sorts, search, limit, offset, groupBy }
    // NEW: Render overrides (deltas from defaults only)
    config: jsonb("config").default("{}"), // { hiddenColumns, visibleColumns, columnOrder, columnWidths, ... }
    // Legacy columns (kept for backward compatibility during migration)
    filter: jsonb("filter").default("{}"), // @deprecated - use query.filters
    sort: jsonb("sort").default("{}"), // @deprecated - use query.sorts
    columns: jsonb("columns").default("[]"), // @deprecated - columns computed from profiles
    layoutConfig: jsonb("layout_config").default("{}"), // @deprecated - use config
    // Content reference (stores actual view data as JSON)
    documentId: uuid("document_id").references(() => documents.id, {
        onDelete: "set null",
    }),
    // Canvas-specific fields (nullable for structured views)
    yjsRoomId: text("yjs_room_id"), // For real-time collaboration
    thumbnailUrl: text("thumbnail_url"), // Preview image
    // Optional: Schema snapshot cache (performance optimization)
    schemaSnapshot: jsonb("schema_snapshot"), // Cached property info from scopeProfileIds
    snapshotUpdatedAt: timestamp("snapshot_updated_at", {
        mode: "date",
        withTimezone: true,
    }),
    // Composition support (for composite views like bento grid)
    embeddedViewIds: uuid("embedded_view_ids").array(), // Views embedded in this view
    // Quick-access metadata (for listings, thumbnails, search)
    metadata: jsonb("metadata").default("{}").notNull(),
    // {
    //   thumbnail: 'url-to-thumbnail.png',
    //   entityCount: 10,
    //   lastEditedBy: 'user-123',
    //   bounds: { width: 1920, height: 1080 },
    //   // Legacy: viewConfig moved to query + config
    // }
    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
        .defaultNow()
        .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
        .defaultNow()
        .notNull(),
});
// Generate Zod schemas (Single Source of Truth)
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertViewSchema = createInsertSchema(views);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectViewSchema = createSelectSchema(views);
//# sourceMappingURL=views.js.map