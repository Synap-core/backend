/**
 * Content Blocks Schema - Hybrid Content Storage
 * 
 * Phase 1: Content stored in DB (storageProvider='db')
 * Phase 2+: Content stored in S3/R2/Git (references only)
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 * - SQLite: embedding stored as JSON
 * - PostgreSQL: embedding stored as vector (pgvector)
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { entities } from './entities.js';

export const contentBlocks = sqliteTable('content_blocks', {
  // Primary key (also foreign key to entity)
  entityId: text('entity_id')
    .primaryKey()
    .references(() => entities.id, { onDelete: 'cascade' }),
  
  // ═══════════════════════════════════════════════════════
  // STORAGE CONFIGURATION (Where is the content?)
  // ═══════════════════════════════════════════════════════
  
  storageProvider: text('storage_provider')
    .default('db')
    .notNull(), // 'db' | 's3' | 'r2' | 'git' | 'local'
  
  storagePath: text('storage_path'), // Path in storage provider (e.g., 's3://bucket/users/abc/notes/123.md')
  
  storageUrl: text('storage_url'), // Signed URL (S3) or public URL (Git)
  
  // ═══════════════════════════════════════════════════════
  // CONTENT (Phase 1 only - will be null in Phase 2+)
  // ═══════════════════════════════════════════════════════
  
  content: text('content'), // Nullable! Only populated if storageProvider='db'
  
  // ═══════════════════════════════════════════════════════
  // METADATA (Always in DB)
  // ═══════════════════════════════════════════════════════
  
  contentType: text('content_type')
    .default('markdown')
    .notNull(), // 'markdown' | 'audio' | 'video' | 'pdf' | 'image'
  
  mimeType: text('mime_type'), // 'text/markdown', 'audio/wav', etc.
  
  sizeBytes: integer('size_bytes'), // File size
  
  checksum: text('checksum'), // MD5/SHA256 for change detection
  
  // ═══════════════════════════════════════════════════════
  // SEARCH (JSON for SQLite, vector for PostgreSQL in Phase 2)
  // ═══════════════════════════════════════════════════════
  
  embedding: text('embedding', { mode: 'json' }).$type<number[]>(), // Array of numbers for semantic search
  
  embeddingModel: text('embedding_model')
    .default('text-embedding-3-small'),
  
  // ═══════════════════════════════════════════════════════
  // TIMESTAMPS (Unix timestamps in ms)
  // ═══════════════════════════════════════════════════════
  
  uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
  lastModifiedAt: integer('last_modified_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type ContentBlock = typeof contentBlocks.$inferSelect;
export type NewContentBlock = typeof contentBlocks.$inferInsert;

