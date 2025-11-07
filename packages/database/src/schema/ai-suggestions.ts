import { randomUUID } from 'crypto';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let aiSuggestions: any;

if (isPostgres) {
  const pg = require('drizzle-orm/pg-core') as typeof import('drizzle-orm/pg-core');
  const { pgTable, uuid, text, jsonb, real, timestamp } = pg;

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
  const sqlite = require('drizzle-orm/sqlite-core') as typeof import('drizzle-orm/sqlite-core');
  const { sqliteTable, text, real, integer } = sqlite;

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




