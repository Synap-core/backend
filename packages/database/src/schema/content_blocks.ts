/**
 * Content Blocks Schema - Hybrid Content Storage
 * 
 * Phase 1: Content stored in DB (storageProvider='db')
 * Phase 2+: Content stored in S3/R2/Git (references only)
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 * - SQLite: embedding stored as JSON array
 * - PostgreSQL: embedding stored as vector(1536) with pgvector
 */

import { entities } from './entities.js';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let contentBlocks: any;

if (isPostgres) {
  // PostgreSQL schema with pgvector support
  const { pgTable, uuid, text, integer, timestamp } = require('drizzle-orm/pg-core');
  const { vector } = require('drizzle-orm/pg-core');
  
  contentBlocks = pgTable('content_blocks', {
    // Primary key + foreign key
    entityId: uuid('entity_id')
      .primaryKey()
      .references(() => entities.id, { onDelete: 'cascade' }),
    
    // Storage configuration
    storageProvider: text('storage_provider')
      .default('db')
      .notNull(),
    storagePath: text('storage_path'),
    storageUrl: text('storage_url'),
    
    // Content (nullable for Phase 2+)
    content: text('content'),
    
    // Metadata
    contentType: text('content_type')
      .default('markdown')
      .notNull(),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    checksum: text('checksum'),
    
    // **pgvector** for efficient similarity search
    embedding: vector('embedding', { dimensions: 1536 }), // OpenAI embedding size
    embeddingModel: text('embedding_model')
      .default('text-embedding-3-small'),
    
    // Timestamps
    uploadedAt: timestamp('uploaded_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    lastModifiedAt: timestamp('last_modified_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  });
} else {
  // SQLite schema (JSON array for embeddings)
  const { sqliteTable, text, integer } = require('drizzle-orm/sqlite-core');
  
  contentBlocks = sqliteTable('content_blocks', {
    // Primary key + foreign key
    entityId: text('entity_id')
      .primaryKey()
      .references(() => entities.id, { onDelete: 'cascade' }),
    
    // Storage configuration
    storageProvider: text('storage_provider')
      .default('db')
      .notNull(),
    storagePath: text('storage_path'),
    storageUrl: text('storage_url'),
    
    // Content
    content: text('content'),
    
    // Metadata
    contentType: text('content_type')
      .default('markdown')
      .notNull(),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    checksum: text('checksum'),
    
    // Embedding as JSON array (less efficient than pgvector, but works)
    embedding: text('embedding', { mode: 'json' }),
    embeddingModel: text('embedding_model')
      .default('text-embedding-3-small'),
    
    // Timestamps
    uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
    lastModifiedAt: integer('last_modified_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  });
}

export { contentBlocks };

export type ContentBlock = typeof contentBlocks.$inferSelect;
export type NewContentBlock = typeof contentBlocks.$inferInsert;

