/**
 * Tags Schema - For organizing entities
 * 
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';

export const tags = pgTable('tags', {
  // Primary key
  id: uuid('id').defaultRandom().primaryKey(),
  
  // Which user owns this tag?
  userId: text('user_id').notNull(),
  
  // Tag name (unique per user)
  name: text('name').notNull(),
  
  // Display color
  color: text('color'),
  
  // Timestamps
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
