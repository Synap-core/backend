/**
 * Knowledge Facts Schema
 *
 * Stores extracted knowledge facts with embeddings for semantic search.
 *
 * PostgreSQL-only schema with pgvector for embeddings and Row-Level Security (RLS) for multi-user support.
 */

import {
  pgTable,
  uuid,
  text,
  real,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";

export const knowledgeFacts = pgTable("knowledge_facts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").notNull(),
  fact: text("fact").notNull(),
  sourceEntityId: uuid("source_entity_id"),
  sourceMessageId: uuid("source_message_id"),
  confidence: real("confidence").default(0.5).notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type KnowledgeFactRow = typeof knowledgeFacts.$inferSelect;
export type NewKnowledgeFactRow = typeof knowledgeFacts.$inferInsert;
