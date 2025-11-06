/**
 * Events Schema - The Immutable Source of Truth
 * 
 * This table stores every event that happens in the system.
 * Events are NEVER updated or deleted, only appended.
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'crypto';

export const events = sqliteTable('events', {
  // Primary key (UUID generated in app code)
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  
  // When did this event occur? (Unix timestamp in ms)
  timestamp: integer('timestamp', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
  
  // What type of event is this?
  // Examples: 'entity.created', 'task.completed', 'relation.added'
  type: text('type').notNull(),
  
  // Event payload (JSON structure)
  data: text('data', { mode: 'json' }).$type<Record<string, any>>().notNull(),
  
  // Where did this event come from?
  // 'api' | 'automation' | 'sync' | 'migration'
  source: text('source').default('api'),
  
  // For tracing related events
  correlationId: text('correlation_id'),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

