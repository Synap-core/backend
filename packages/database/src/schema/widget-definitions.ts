/**
 * Widget Definitions Schema
 *
 * Stores widget type definitions for the dynamic bento widget registry.
 * - workspaceId = null → system-wide built-in widgets
 * - workspaceId set → workspace-specific custom widgets (AI-generated or iframe)
 *
 * configSchema (JSONSchema) drives:
 *   1. IS config generation/validation
 *   2. Settings form auto-generation in the frontend
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export type WidgetRendererType = "builtin" | "iframe";

export const widgetDefinitions = pgTable(
  "widget_definitions",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    /** Unique type key within scope, e.g. "entity-list", "win-rate-gauge" */
    typeKey: text("type_key").notNull(),

    /**
     * NULL = system-wide (built-ins, seeded at startup).
     * Set = workspace-specific custom widget.
     */
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),

    // ── Display ──────────────────────────────────────────────────────────

    name: text("name").notNull(),
    description: text("description"),

    /** Lucide icon name, e.g. "bar-chart-3" */
    icon: text("icon"),

    /** Grouping label: "core" | "data" | "ai" | "app-specific" */
    category: text("category"),

    // ── Renderer ─────────────────────────────────────────────────────────

    /** "builtin" = precompiled React component; "iframe" = sandboxed HTML */
    rendererType: text("renderer_type")
      .notNull()
      .default("builtin")
      .$type<WidgetRendererType>(),

    /**
     * Full HTML document for iframe widgets (includes SynapWidget SDK).
     * NULL for built-ins — they are resolved by the frontend cell registry.
     */
    rendererSource: text("renderer_source"),

    // ── Config schema ────────────────────────────────────────────────────

    /**
     * JSONSchema describing the per-instance config this widget accepts.
     * Stored as JSONB; used for IS config validation + settings form auto-gen.
     */
    configSchema: jsonb("config_schema")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** Sensible defaults applied when a new block is created. */
    defaultConfig: jsonb("default_config")
      .$type<Record<string, unknown>>()
      .default({}),

    /** Default grid size in 12-column units. */
    defaultSize: jsonb("default_size")
      .$type<{ w: number; h: number }>()
      .notNull()
      .default({ w: 6, h: 4 }),

    /** Minimum grid size; optional. */
    minSize: jsonb("min_size").$type<{ w: number; h: number }>(),

    // ── Lifecycle ────────────────────────────────────────────────────────

    isActive: boolean("is_active").notNull().default(true),
    version: text("version").default("1.0.0"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    /** typeKey is unique within a workspace scope (null = system) */
    typeKeyWorkspaceUniq: uniqueIndex("widget_def_type_key_workspace_uniq").on(
      table.typeKey,
      table.workspaceId
    ),

    workspaceIdIdx: index("widget_def_workspace_id_idx").on(table.workspaceId),
    isActiveIdx: index("widget_def_is_active_idx").on(table.isActive),
  })
);

export type WidgetDefinition = typeof widgetDefinitions.$inferSelect;
export type NewWidgetDefinition = typeof widgetDefinitions.$inferInsert;
