/**
 * Relation Definitions Schema
 *
 * Defines reusable relation type definitions per workspace.
 * Like property_defs but for relationship types between entity profiles.
 *
 * Examples: "works_at", "manages", "supplies_to"
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const relationDefs = pgTable(
  "relation_defs",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Relation identity (unique per workspace)
    slug: text("slug").notNull(), // e.g. "works_at", "manages"
    displayName: text("display_name").notNull(), // e.g. "Works at"
    description: text("description"),

    // Workspace scope — nullable for pod-wide relation definitions
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    userId: text("user_id").notNull(), // Creator

    // UI hints (JSONB)
    // Examples:
    // - { icon: "arrow-right", color: "#3B82F6", inverseLabel: "Has employee" }
    uiHints: jsonb("ui_hints").default("{}").notNull(),

    // Whether this relation is directional (A→B ≠ B→A)
    isDirectional: boolean("is_directional").default(true).notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Uniqueness enforced via partial indexes (migration 0118):
    //   - pod-wide:  UNIQUE (slug) WHERE workspace_id IS NULL
    //   - workspace: UNIQUE (slug, workspace_id) WHERE workspace_id IS NOT NULL
    workspaceIdx: index("relation_defs_workspace_id_idx").on(table.workspaceId),
  })
);

export type RelationDef = typeof relationDefs.$inferSelect;
export type NewRelationDef = typeof relationDefs.$inferInsert;

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertRelationDefSchema = createInsertSchema(relationDefs);
export const selectRelationDefSchema = createSelectSchema(relationDefs);
