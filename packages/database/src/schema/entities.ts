/**
 * Entities Schema - The Knowledge Graph Nodes
 * 
 * This is a projection (materialized view) of the event stream.
 * Single-user local version (no userId field for simplicity)
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'crypto';

export const entities = sqliteTable('entities', {
  // Primary key (UUID generated in app code)
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  
  // Entity type: 'note', 'task', 'project', 'page', 'habit', 'event'
  type: text('type').notNull(),
  
  // Display metadata (NOT the full content!)
  // These are denormalized from content_blocks for fast queries
  title: text('title'),
  preview: text('preview'), // First 200 characters (copied by projector)
  
  // Optimistic locking for concurrency control
  version: integer('version').default(1).notNull(),
  
  // Timestamps (Unix timestamps in ms)
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }), // Soft delete
});

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;

