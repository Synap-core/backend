import { randomUUID } from 'crypto';
import * as pgCore from 'drizzle-orm/pg-core';
import * as sqliteCore from 'drizzle-orm/sqlite-core';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let aiSuggestions: any;

if (isPostgres) {
  const { pgTable, uuid, text, jsonb, real, timestamp } = pgCore;

  aiSuggestions = pgTable('ai_suggestions', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    type: text('type').notNull(),
    status: text('status').default('pending').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    payload: jsonb('payload'),
    confidence: real('confidence').default(0.5).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  });
} else {
  const { sqliteTable, text, real, integer } = sqliteCore;

  aiSuggestions = sqliteTable('ai_suggestions', {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    type: text('type').notNull(),
    status: text('status').default('pending').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    payload: text('payload', { mode: 'json' }),
    confidence: real('confidence').default(0.5).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  });
}

export { aiSuggestions };

export type AISuggestionRow = typeof aiSuggestions.$inferSelect;
export type NewAISuggestionRow = typeof aiSuggestions.$inferInsert;




