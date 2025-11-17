/**
 * Tags Schema - For organizing entities
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { randomUUID } from 'crypto';
import * as pgCore from 'drizzle-orm/pg-core';
import * as sqliteCore from 'drizzle-orm/sqlite-core';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let tags: any;

if (isPostgres) {
  // PostgreSQL schema
  const { pgTable, uuid, text, timestamp } = pgCore;
  
  tags = pgTable('tags', {
    // Primary key
    id: uuid('id').defaultRandom().primaryKey(),
    
    // **NEW for Multi-User**: Which user owns this tag?
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
} else {
  // SQLite schema (single-user, no userId)
  const { sqliteTable, text, integer } = sqliteCore;
  
  tags = sqliteTable('tags', {
    // Primary key
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    
    // Tag name
    name: text('name').notNull(),
    
    // Display color
    color: text('color'),
    
    // Timestamps (Unix timestamps in ms)
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  });
}

export { tags };

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
