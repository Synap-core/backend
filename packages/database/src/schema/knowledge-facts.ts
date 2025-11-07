import { randomUUID } from 'crypto';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let knowledgeFacts: any;

if (isPostgres) {
  const pg = require('drizzle-orm/pg-core') as typeof import('drizzle-orm/pg-core');
  const { pgTable, uuid, text, real, timestamp, vector } = pg;

  knowledgeFacts = pgTable('knowledge_facts', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    fact: text('fact').notNull(),
    sourceEntityId: uuid('source_entity_id'),
    sourceMessageId: uuid('source_message_id'),
    confidence: real('confidence').default(0.5).notNull(),
    embedding: vector('embedding', { dimensions: 1536 }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true })
      .defaultNow()
      .notNull(),
  });
} else {
  const sqlite = require('drizzle-orm/sqlite-core') as typeof import('drizzle-orm/sqlite-core');
  const { sqliteTable, text, real, integer } = sqlite;

  knowledgeFacts = sqliteTable('knowledge_facts', {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    fact: text('fact').notNull(),
    sourceEntityId: text('source_entity_id'),
    sourceMessageId: text('source_message_id'),
    confidence: real('confidence').default(0.5).notNull(),
    embedding: text('embedding', { mode: 'json' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .$defaultFn(() => new Date())
      .notNull(),
  });
}

export { knowledgeFacts };

export type KnowledgeFactRow = typeof knowledgeFacts.$inferSelect;
export type NewKnowledgeFactRow = typeof knowledgeFacts.$inferInsert;




