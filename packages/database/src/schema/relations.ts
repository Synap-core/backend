/**
 * Relations Schema - The Knowledge Graph Edges
 * 
 * Links between entities, forming the knowledge graph.
 * Single-user local version (no userId)
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'crypto';
import { entities } from './entities.js';

export const relations = sqliteTable('relations', {
  // Primary key (UUID generated in app code)
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  
  // The two entities being linked
  sourceEntityId: text('source_entity_id')
    .references(() => entities.id, { onDelete: 'cascade' })
    .notNull(),
  targetEntityId: text('target_entity_id')
    .references(() => entities.id, { onDelete: 'cascade' })
    .notNull(),
  
  // Relationship type
  // Examples: 'contains', 'relates_to', 'blocks', 'duplicates', 'mentions'
  type: text('type').notNull(),
  
  // When was this link created?
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type Relation = typeof relations.$inferSelect;
export type NewRelation = typeof relations.$inferInsert;

