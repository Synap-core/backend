/**
 * Relations Schema - The Knowledge Graph Edges
 * 
 * Links between entities, forming the knowledge graph.
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { randomUUID } from 'crypto';
import * as pgCore from 'drizzle-orm/pg-core';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import { entities } from './entities.js';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let relations: any;

if (isPostgres) {
  // PostgreSQL schema
  const { pgTable, uuid, text, timestamp } = pgCore;
  
  relations = pgTable('relations', {
    // Primary key
    id: uuid('id').defaultRandom().primaryKey(),
    
    // **NEW for Multi-User**: Which user owns this relation?
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
} else {
  // SQLite schema (single-user, no userId)
  const { sqliteTable, text, integer } = sqliteCore;
  
  relations = sqliteTable('relations', {
    // Primary key
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    
    // The two entities being linked
    sourceEntityId: text('source_entity_id')
      .references(() => entities.id, { onDelete: 'cascade' })
      .notNull(),
    targetEntityId: text('target_entity_id')
      .references(() => entities.id, { onDelete: 'cascade' })
      .notNull(),
    
    // Relationship type
    type: text('type').notNull(),
    
    // Timestamps
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  });
}

export { relations };

export type Relation = typeof relations.$inferSelect;
export type NewRelation = typeof relations.$inferInsert;

