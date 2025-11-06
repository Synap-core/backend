/**
 * Tags Schema - For organizing entities
 * 
 * Multi-dialect compatible (SQLite + PostgreSQL)
 */

import { randomUUID } from 'crypto';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let tags: any;

if (isPostgres) {
  // PostgreSQL schema
  const { pgTable, uuid, text, timestamp } = require('drizzle-orm/pg-core');
  
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
  const { sqliteTable, text, integer } = require('drizzle-orm/sqlite-core');
  
  tags = sqliteTable('tags', {
    // Primary key
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    
    // Tag name
    name: text('name').notNull().unique(),
    
    // Display color
    color: text('color'),
    
    // Created timestamp
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  });
}

export { tags };

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

