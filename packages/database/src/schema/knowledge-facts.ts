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
  integer,
  bigint,
  timestamp,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  accessCount: integer("access_count").notNull().default(0),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
  relevanceScore: real("relevance_score").notNull().default(1),
  /**
   * Stored sha256 of `fact` (0216) — race-fix dedup key, see migration
   * 0216_knowledge_facts_dedup.sql. Generated column: never written directly.
   */
  factHash: text("fact_hash").generatedAlwaysAs(
    sql`encode(digest(fact, 'sha256'), 'hex')`
  ),
  /**
   * ~10-minute dedup window bucket (0216) — floor(epoch(now) / 600), applied as a
   * DB column DEFAULT at insert time (NOT a generated column: extract(epoch FROM
   * timestamptz) is STABLE, not IMMUTABLE, so it can't back GENERATED ALWAYS —
   * PG 42P17). The app never writes this; the DB DEFAULT fills it. Pre-0216 rows
   * are NULL (distinct in the unique index, so they never block index creation).
   */
  dedupBucket: bigint("dedup_bucket", { mode: "number" }),
});

export type KnowledgeFactRow = typeof knowledgeFacts.$inferSelect;
export type NewKnowledgeFactRow = typeof knowledgeFacts.$inferInsert;
