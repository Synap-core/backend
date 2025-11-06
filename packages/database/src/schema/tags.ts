/**
 * Tags Schema - For organizing entities
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'crypto';

export const tags = sqliteTable('tags', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  
  // Tag name (unique)
  name: text('name').notNull().unique(),
  
  // Display color (hex)
  color: text('color'),
  
  // Created timestamp
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

