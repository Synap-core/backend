/**
 * Relations Schema - The Knowledge Graph Edges
 * 
 * Links between entities, forming the knowledge graph.
 * 
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { entities } from './entities.js';
import { z } from 'zod';

export const relations = pgTable('relations', {
  // Primary key
  id: uuid('id').defaultRandom().primaryKey(),
  
  // Which user owns this relation?
  userId: text('user_id').notNull(),
  
  // The two entities being linked
  sourceEntityId: uuid('source_entity_id')
    .references(() => entities.id, { onDelete: 'cascade' })
    .notNull(),
  targetEntityId: uuid('target_entity_id')
    .references(() => entities.id, { onDelete: 'cascade' })
    .notNull(),
  
  // Relationship type
  type: text('type').notNull(),
  
  // Timestamps
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Relation = typeof relations.$inferSelect;
export type NewRelation = typeof relations.$inferInsert;

/**
 * Relation type schema
 * 
 * NOTE: Relations are created via event sourcing (events.log → relationsWorker)
 * The insertRelationSchema from database is available if direct creation is needed:
 * insertRelationSchema.pick({ sourceEntityId, targetEntityId, type, ... })
 */
export const RelationTypeSchema = z.enum([
  'assigned_to',
  'mentions',
  'links_to',
  'parent_of',
  'relates_to',
  'tagged_with',
  'created_by',
  'attended_by',
  'depends_on',
  'blocks',
  // NEW - Computed from view content (optional, for analytics/backlinks)
  'embedded_in',      // Entity/View embedded in View/Document
  'visualized_in',    // Entity shown in View (for tracking)
  'references',       // Document references Entity
]);

export type RelationType = z.infer<typeof RelationTypeSchema>;

import { createInsertSchema, createSelectSchema } from 'drizzle-zod';

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
