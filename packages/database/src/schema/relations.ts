/**
 * Relations Schema - The Knowledge Graph Edges
 * 
 * Links between entities, forming the knowledge graph.
 * 
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { entities } from './entities.js';

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

