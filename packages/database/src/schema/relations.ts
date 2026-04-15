/**
 * Relations Schema - The Knowledge Graph Edges
 *
 * Links between entities, forming the knowledge graph.
 *
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
export const relations = pgTable("relations", {
  // Primary key
  id: uuid("id").defaultRandom().primaryKey(),

  // Context
  userId: text("user_id").notNull(),
  // Nullable for pod-wide relations.
  workspaceId: uuid("workspace_id"),
  // Projects: Use relations table with type "belongs_to_project" (self-referencing)

  // The two entities being linked
  sourceEntityId: uuid("source_entity_id")
    .references(() => entities.id, { onDelete: "cascade" })
    .notNull(),
  targetEntityId: uuid("target_entity_id")
    .references(() => entities.id, { onDelete: "cascade" })
    .notNull(),

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
