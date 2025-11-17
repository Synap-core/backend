/**
 * Entity Vectors Schema - Separate Embeddings Table
 * 
 * V0.3: Embeddings moved out of entities table for better performance
 * 
 * Why separate table?
 * - Large vectors slow down entity queries
 * - Different indexing strategy (HNSW)
 * - Can rebuild embeddings without touching entities
 * - Supports multiple embedding models per entity
 */

import * as pgCore from 'drizzle-orm/pg-core';
import * as sqliteCore from 'drizzle-orm/sqlite-core';
import { entities } from './entities.js';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let entityVectors: any;

if (isPostgres) {
  // PostgreSQL schema with pgvector
  const { pgTable, uuid, text, timestamp, vector } = pgCore;
  
  entityVectors = pgTable('entity_vectors', {
    // Foreign key to entities (one-to-one)
    entityId: uuid('entity_id')
      .primaryKey()
      .references(() => entities.id, { onDelete: 'cascade' }),
    
    // User ID (for filtering)
    userId: text('user_id').notNull(),
    
    // Embedding vector
    embedding: (vector('embedding', { dimensions: 1536 }) as any),
    embeddingModel: text('embedding_model').default('text-embedding-3-small').notNull(),
    
    // Denormalized fields for search performance
    entityType: text('entity_type').notNull(),
    title: text('title'),
    preview: text('preview'),  // First 500 chars
    fileUrl: text('file_url'),
    
    // Timestamps
    indexedAt: timestamp('indexed_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  });
} else {
  // SQLite schema (single-user, no pgvector)
  const { sqliteTable, text, integer } = sqliteCore;
  
  entityVectors = sqliteTable('entity_vectors', {
    // Foreign key to entities
    entityId: text('entity_id')
      .primaryKey()
      .references(() => entities.id, { onDelete: 'cascade' }),
    
    // Embedding as JSON array
    embedding: text('embedding', { mode: 'json' }),
    embeddingModel: text('embedding_model').default('text-embedding-3-small').notNull(),
    
    // Denormalized fields
    entityType: text('entity_type').notNull(),
    title: text('title'),
    preview: text('preview'),
    fileUrl: text('file_url'),
    
    // Timestamps (Unix timestamps in ms)
    indexedAt: integer('indexed_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  });
}

export { entityVectors };

export type EntityVector = typeof entityVectors.$inferSelect;
export type NewEntityVector = typeof entityVectors.$inferInsert;

