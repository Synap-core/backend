import { randomUUID } from 'crypto';
import * as pgCore from 'drizzle-orm/pg-core';
import * as sqliteCore from 'drizzle-orm/sqlite-core';

const isPostgres = process.env.DB_DIALECT === 'postgres';

let knowledgeFacts: any;

if (isPostgres) {
  const { pgTable, uuid, text, real, timestamp, vector } = pgCore;

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
  const { sqliteTable, text, real, integer } = sqliteCore;

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




