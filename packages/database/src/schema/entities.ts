/**
 * Entities Schema - The Knowledge Graph Nodes
 * 
 * This is a projection (materialized view) of the event stream.
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { randomUUID } from 'crypto';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let entities: any;

if (isPostgres) {
  // PostgreSQL schema
  const { pgTable, uuid, timestamp, text, integer } = require('drizzle-orm/pg-core');
  
  entities = pgTable('entities', {
    // Primary key
    id: uuid('id').defaultRandom().primaryKey(),
    
    // **NEW for Multi-User**: Which user owns this entity?
    userId: text('user_id').notNull(),
    
    // Entity type: 'note', 'task', 'project', 'page', 'habit', 'event'
    type: text('type').notNull(),
    
    // Display metadata (NOT the full content!)
    title: text('title'),
    preview: text('preview'),
    
    // **V0.3 NEW**: File storage references (R2/S3/Local)
    fileUrl: text('file_url'),        // Public URL: https://r2.../users/123/notes/456.md
    filePath: text('file_path'),      // Storage key: users/123/notes/456.md
    fileSize: integer('file_size'),   // Size in bytes
    fileType: text('file_type'),      // 'markdown', 'pdf', 'audio', 'video', 'image'
    checksum: text('checksum'),       // SHA256 hash for integrity verification
    
    // Optimistic locking
    version: integer('version').default(1).notNull(),
    
    // Timestamps
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { mode: 'date', withTimezone: true }),
  });
} else {
  // SQLite schema (single-user, no userId)
  const { sqliteTable, text, integer } = require('drizzle-orm/sqlite-core');
  
  entities = sqliteTable('entities', {
    // Primary key (UUID generated in app code)
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    
    // Entity type
    type: text('type').notNull(),
    
    // Display metadata
    title: text('title'),
    preview: text('preview'),
    
    // **V0.3 NEW**: File storage references (R2/S3/Local)
    fileUrl: text('file_url'),        // Public URL
    filePath: text('file_path'),      // Storage key
    fileSize: integer('file_size'),   // Size in bytes
    fileType: text('file_type'),      // 'markdown', 'pdf', 'audio', 'video', 'image'
    checksum: text('checksum'),       // SHA256 hash
    
    // Optimistic locking
    version: integer('version').default(1).notNull(),
    
    // Timestamps (Unix timestamps in ms)
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
  });
}

export { entities };

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

