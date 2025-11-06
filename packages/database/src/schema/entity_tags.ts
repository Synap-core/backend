/**
 * Entity Tags Schema - Many-to-Many relationship
 * 
 * Links entities to tags
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'crypto';
import { entities } from './entities.js';
import { tags } from './tags.js';

export const entityTags = sqliteTable('entity_tags', {
  // Primary key
  id: text('id').primaryKey().$defaultFn(() => randomUUID()),
  
  // References
  entityId: text('entity_id')
    .references(() => entities.id, { onDelete: 'cascade' })
    .notNull(),
  tagId: text('tag_id')
    .references(() => tags.id, { onDelete: 'cascade' })
    .notNull(),
  
  // When was this tag added?
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .$defaultFn(() => new Date())
    .notNull(),
});

export type EntityTag = typeof entityTags.$inferSelect;
export type NewEntityTag = typeof entityTags.$inferInsert;

