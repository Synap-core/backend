/**
 * Entities Schema - The Knowledge Graph Nodes
 * 
 * This is a projection (materialized view) of the event stream.
 * 
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, timestamp, text, integer } from 'drizzle-orm/pg-core';

export const entities = pgTable('entities', {
  // Primary key
  id: uuid('id').defaultRandom().primaryKey(),
  
  // Which user owns this entity?
  userId: text('user_id').notNull(),
  
  // Entity type: 'note', 'task', 'project', 'page', 'habit', 'event'
  type: text('type').notNull(),
  
  // Display metadata (NOT the full content!)
  title: text('title'),
  preview: text('preview'),
  
  // File storage references (R2/S3/Local)
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

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

