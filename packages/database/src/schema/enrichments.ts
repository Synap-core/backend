/**
 * Entity Enrichments Schema
 *
 * Stores AI-generated enrichments for entities.
 * This is a PROJECTION from enrichment events - can be rebuilt anytime.
 *
 * @module @synap/database/schema/enrichments
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  decimal,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { entities } from "./entities.js";
import { events } from "./events.js";

// ============================================================================
// ENTITY ENRICHMENTS TABLE
// ============================================================================

/**
 * Entity Enrichments Table
 *
 * Stores enrichments for entities (extraction metadata, inferred properties, etc.)
 * Each enrichment links back to its source event for full traceability.
 */
export const entityEnrichments = pgTable(
  "entity_enrichments",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // What was enriched
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),

    // Enrichment type
    enrichmentType: text("enrichment_type", {
      enum: ["extraction", "properties", "classification", "knowledge"],
    }).notNull(),

    // Source event (for traceability - can rebuild from events)
    sourceEventId: uuid("source_event_id")
      .notNull()
      .references(() => events.id),

    // AI metadata
    agentId: text("agent_id").notNull(),
    confidence: decimal("confidence", { precision: 3, scale: 2 }).notNull(),

    // Enrichment data (flexible JSONB)
    data: jsonb("data").notNull(),

    // Multi-tenant
    userId: text("user_id").notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Index for fast entity lookups
    entityIdIdx: index("entity_enrichments_entity_id_idx").on(table.entityId),

    // Index for user filtering (RLS)
    userIdIdx: index("entity_enrichments_user_id_idx").on(table.userId),

    // Index for type filtering
    typeIdx: index("entity_enrichments_type_idx").on(table.enrichmentType),

    // Composite index for common query pattern
    entityUserIdx: index("entity_enrichments_entity_user_idx").on(
      table.entityId,
      table.userId,
    ),
  }),
);

export type EntityEnrichment = typeof entityEnrichments.$inferSelect;
export type NewEntityEnrichment = typeof entityEnrichments.$inferInsert;

// ============================================================================
// ENTITY RELATIONSHIPS TABLE
// ============================================================================

/**
 * Entity Relationships Table
 *
 * Stores AI-discovered relationships between entities.
 * Enables knowledge graph queries and traversal.
 */
export const entityRelationships = pgTable(
  "entity_relationships",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // Relationship endpoints
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),

    // Relationship type
    relationshipType: text("relationship_type", {
      enum: [
        "related_to",
        "part_of",
        "depends_on",
        "mentioned_in",
        "created_from",
        "supersedes",
        "similar_to",
        "contradicts",
      ],
    }).notNull(),

    // AI metadata
    sourceEventId: uuid("source_event_id")
      .notNull()
      .references(() => events.id),
    agentId: text("agent_id").notNull(),
    confidence: decimal("confidence", { precision: 3, scale: 2 }).notNull(),

    // Optional context
    context: text("context"),

    // Multi-tenant
    userId: text("user_id").notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Graph traversal indexes
    sourceIdx: index("entity_relationships_source_idx").on(
      table.sourceEntityId,
    ),
    targetIdx: index("entity_relationships_target_idx").on(
      table.targetEntityId,
    ),

    // User filtering (RLS)
    userIdIdx: index("entity_relationships_user_id_idx").on(table.userId),

    // Prevent duplicate relationships
    uniqueRelationship: unique("entity_relationships_unique").on(
      table.sourceEntityId,
      table.targetEntityId,
      table.relationshipType,
    ),
  }),
);

export type EntityRelationship = typeof entityRelationships.$inferSelect;
export type NewEntityRelationship = typeof entityRelationships.$inferInsert;

// ============================================================================
// REASONING TRACES TABLE
// ============================================================================

/**
 * Reasoning Traces Table
 *
 * Stores AI reasoning traces for transparency.
 * Enables users to understand why AI made certain decisions.
 */
export const reasoningTraces = pgTable(
  "reasoning_traces",
  {
    // Identity
    id: uuid("id").defaultRandom().primaryKey(),

    // What this reasoning is about
    subjectType: text("subject_type", {
      enum: ["entity", "message", "thread", "query", "task"],
    }).notNull(),
    subjectId: uuid("subject_id").notNull(),

    // Source event
    sourceEventId: uuid("source_event_id")
      .notNull()
      .references(() => events.id),

    // The agent that did the reasoning
    agentId: text("agent_id").notNull(),

    // Reasoning data (steps, outcome, metrics)
    steps: jsonb("steps").notNull(), // Array of reasoning steps
    outcome: jsonb("outcome").notNull(), // Final decision
    metrics: jsonb("metrics"), // Performance metrics

    // Multi-tenant
    userId: text("user_id").notNull(),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Subject lookup
    subjectIdx: index("reasoning_traces_subject_idx").on(
      table.subjectType,
      table.subjectId,
    ),

    // User filtering (RLS)
    userIdIdx: index("reasoning_traces_user_id_idx").on(table.userId),

    // Agent analytics
    agentIdx: index("reasoning_traces_agent_idx").on(table.agentId),
  }),
);

export type ReasoningTrace = typeof reasoningTraces.$inferSelect;
export type NewReasoningTrace = typeof reasoningTraces.$inferInsert;
