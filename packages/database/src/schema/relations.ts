/**
 * Relations Schema - The Knowledge Graph Edges
 *
 * Links between entities, forming the knowledge graph.
 *
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { cellInstances } from "./cell-instances.js";

/**
 * The kind of object on one end of a relation edge.
 *
 * Relations are polymorphic: each endpoint is EITHER an entity (kind='entity',
 * resolved via {source,target}EntityId — the original, default behavior) OR a
 * cell instance (kind='cell', resolved via {source,target}CellId).
 *
 * Existing relations default to 'entity' on both ends and keep working
 * unchanged — the entity columns stay populated and the cell columns are NULL.
 */
export type RelationEndpointKind = "entity" | "cell";

export const relations = pgTable("relations", {
  // Primary key
  id: uuid("id").defaultRandom().primaryKey(),

  // Context
  userId: text("user_id").notNull(),
  // Nullable for pod-wide relations.
  workspaceId: uuid("workspace_id"),
  // Projects: Use relations table with type "belongs_to_project" (self-referencing)

  // ── Polymorphic endpoints ────────────────────────────────────────────────
  // Each end is (kind='entity' → entityId) OR (kind='cell' → cellId).
  // Entity columns are NULLABLE now (a cell endpoint leaves them NULL) but every
  // pre-existing row keeps both populated with kind defaulting to 'entity'.
  sourceEntityId: uuid("source_entity_id").references(() => entities.id, {
    onDelete: "cascade",
  }),
  targetEntityId: uuid("target_entity_id").references(() => entities.id, {
    onDelete: "cascade",
  }),

  /** Endpoint kind for the source end. Defaults to 'entity' (legacy behavior). */
  sourceKind: text("source_kind")
    .notNull()
    .default("entity")
    .$type<RelationEndpointKind>(),
  /** Endpoint kind for the target end. Defaults to 'entity' (legacy behavior). */
  targetKind: text("target_kind")
    .notNull()
    .default("entity")
    .$type<RelationEndpointKind>(),

  /** Cell-instance endpoint when sourceKind='cell'. NULL otherwise. */
  sourceCellId: uuid("source_cell_id").references(() => cellInstances.id, {
    onDelete: "cascade",
  }),
  /** Cell-instance endpoint when targetKind='cell'. NULL otherwise. */
  targetCellId: uuid("target_cell_id").references(() => cellInstances.id, {
    onDelete: "cascade",
  }),

  // Relationship type
  type: text("type").notNull(),

  // Metadata (JSONB for extensibility)
  metadata: jsonb("metadata").default("{}"),

  // Timestamps
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Relation = typeof relations.$inferSelect;
export type NewRelation = typeof relations.$inferInsert;

import { createInsertSchema, createSelectSchema } from "drizzle-zod";

/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertRelationSchema = createInsertSchema(relations);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectRelationSchema = createSelectSchema(relations);
export type InsertRelation = NewRelation;
export type SelectRelation = Relation;
