/**
 * Entity Tags Schema - Many-to-Many relationship
 * 
 * Links entities to tags.
 * 
 * PostgreSQL-only schema with Row-Level Security (RLS) for multi-user support.
 */

import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { entities } from './entities.js';
import { tags } from './tags.js';

export const entityTags = pgTable('entity_tags', {
  // Primary key
  id: uuid('id').defaultRandom().primaryKey(),
  
  // User ID (for filtering and RLS)
  userId: text('user_id').notNull(),
  
  // References
  entityId: uuid('entity_id')
    .references(() => entities.id, { onDelete: 'cascade' })
    .notNull(),
  tagId: uuid('tag_id')
    .references(() => tags.id, { onDelete: 'cascade' })
    .notNull(),
  
  // When was this tag added?
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type EntityTag = typeof entityTags.$inferSelect;
export type NewEntityTag = typeof entityTags.$inferInsert;

