/**
 * Cell Instances Schema — The Universal Rendering Unit (persisted)
 *
 * A `cell_instance` is a concrete, addressable instance of a cell type living
 * in a workspace. Where `widget_definitions` describes a cell *type* (the
 * template / renderer), a `cell_instance` is an actual placed/standalone cell
 * with its own config, optional name, and optional backing document.
 *
 * Two complementary persistence paths:
 *   1. `config` (JSONB) — declarative cell config (the common case: composed
 *      cells, charts, maps, embeds referencing other instanceIds, etc.).
 *   2. `sourceDocumentId` — for content-bearing cells (e.g. an `html-embed`
 *      cell), the versioned HTML/markdown lives in a `documents` row (MinIO +
 *      document_versions), and the cell references it. This reuses the existing
 *      document storage path — cells never invent their own blob storage.
 *
 * `isTemplate` marks an instance as a reusable template (duplicated into fresh
 * instances rather than rendered directly).
 *
 * Governance fields mirror `widget_definitions`:
 *   - `createdByKind`  — provenance: 'user' | 'agent' | 'system'
 *   - `trustLevel`     — server-side authority for whether the cell may write
 *                        directly or must propose. Conservative by default for
 *                        agent/marketplace origins.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { documents } from "./documents.js";

/**
 * Who created the cell instance. Provenance only — NOT a write gate by itself
 * (the gate is `trustLevel` + the governance check in the API layer).
 */
export type CellInstanceCreatedByKind = "user" | "agent" | "system";

/**
 * Server-side trust authority for governing a cell instance's writes.
 *
 * Mirrors `WidgetTrustLevel`:
 *   - "trusted"   → first-party / user-authored: may act directly in-envelope.
 *   - "installed" → human-approved marketplace install: proposes.
 *   - "generated" → AI-generated, unreviewed: proposes (most conservative).
 *
 * Default is "trusted" because the canonical create path is a user action; the
 * agent (Hub Protocol) path sets a conservative level explicitly and is routed
 * through `checkPermissionOrPropose()`.
 */
export type CellInstanceTrustLevel = "trusted" | "installed" | "generated";

export const cellInstances = pgTable(
  "cell_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // ── Scope ─────────────────────────────────────────────────────────────
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),

    // ── Identity ──────────────────────────────────────────────────────────
    /** Cell type key, e.g. "html-embed", "entity-list", "chart". */
    cellType: text("cell_type").notNull(),

    /** Per-instance declarative config (drives rendering + child references). */
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** Optional display name. */
    name: text("name"),

    /** When true, this instance is a reusable template (duplicated, not rendered). */
    isTemplate: boolean("is_template").notNull().default(false),

    /**
     * Optional backing document holding versioned HTML/markdown content.
     * NULL for config-only cells. References a `documents` row (MinIO-backed).
     * ON DELETE SET NULL so deleting the document orphans the cell gracefully
     * rather than cascading the cell away.
     */
    sourceDocumentId: uuid("source_document_id").references(
      () => documents.id,
      {
        onDelete: "set null",
      }
    ),

    // ── Governance ────────────────────────────────────────────────────────
    createdByKind: text("created_by_kind")
      .notNull()
      .default("user")
      .$type<CellInstanceCreatedByKind>(),

    trustLevel: text("trust_level")
      .notNull()
      .default("trusted")
      .$type<CellInstanceTrustLevel>(),

    // ── Timestamps ────────────────────────────────────────────────────────
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    workspaceIdIdx: index("cell_instances_workspace_id_idx").on(
      table.workspaceId
    ),
    workspaceTemplateIdx: index("cell_instances_workspace_template_idx").on(
      table.workspaceId,
      table.isTemplate
    ),
    cellTypeIdx: index("cell_instances_cell_type_idx").on(table.cellType),
  })
);

export type CellInstance = typeof cellInstances.$inferSelect;
export type NewCellInstance = typeof cellInstances.$inferInsert;

import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertCellInstanceSchema = createInsertSchema(cellInstances);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectCellInstanceSchema = createSelectSchema(cellInstances);
