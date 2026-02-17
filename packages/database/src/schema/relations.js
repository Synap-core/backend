/**
 * Relations Schema - The Knowledge Graph Edges
 *
 * Links between entities, forming the knowledge graph.
 *
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */
import { pgTable, uuid, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { z } from "zod";
export const relations = pgTable("relations", {
    // Primary key
    id: uuid("id").defaultRandom().primaryKey(),
    // Context
    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(), // Every relation belongs to a workspace
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
/**
 * Relation type schema
 *
 * NOTE: Relations are created via event sourcing (events.log → relationsWorker)
 * The insertRelationSchema from database is available if direct creation is needed:
 * insertRelationSchema.pick({ sourceEntityId, targetEntityId, type, ... })
 */
export const RelationTypeSchema = z.enum([
    "assigned_to",
    "mentions",
    "links_to",
    "parent_of",
    "relates_to",
    "tagged_with",
    "created_by",
    "attended_by",
    "depends_on",
    "blocks",
    "belongs_to_project", // Entity belongs to project (replaces projectIds array)
    // NEW - Computed from view content (optional, for analytics/backlinks)
    "embedded_in", // Entity/View embedded in View/Document
    "visualized_in", // Entity shown in View (for tracking)
    "references", // Document references Entity
]);
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const insertRelationSchema = createInsertSchema(relations);
/**
 * @internal For monorepo usage - enables schema composition in API layer
 */
export const selectRelationSchema = createSelectSchema(relations);
//# sourceMappingURL=relations.js.map