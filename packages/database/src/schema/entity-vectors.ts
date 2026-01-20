/**
 * Entity Vectors Schema - Separate Embeddings Table
 *
 * Embeddings moved out of entities table for better performance.
 *
 * Why separate table?
 * - Large vectors slow down entity queries
 * - Different indexing strategy (HNSW with pgvector)
 * - Can rebuild embeddings without touching entities
 * - Supports multiple embedding models per entity
 *
 * PostgreSQL-only schema with pgvector extension for semantic search.
 */

import { pgTable, uuid, text, timestamp, vector } from "drizzle-orm/pg-core";
import { entities } from "./entities.js";

export const entityVectors = pgTable("entity_vectors", {
  // Foreign key to entities (one-to-one)
  entityId: uuid("entity_id")
    .primaryKey()
    .references(() => entities.id, { onDelete: "cascade" }),

  // User ID (for filtering and RLS)
  userId: text("user_id").notNull(),

  // Embedding vector (pgvector, 1536 dimensions for OpenAI text-embedding-3-small)
  // Note: Drizzle handles number[] -> vector conversion automatically
  embedding: vector("embedding", { dimensions: 1536 }),
  embeddingModel: text("embedding_model")
    .default("text-embedding-3-small")
    .notNull(),

  // Denormalized fields for search performance
  entityType: text("entity_type").notNull(),
  title: text("title"),
  preview: text("preview"), // First 500 chars
  fileUrl: text("file_url"),

  // Timestamps
  indexedAt: timestamp("indexed_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type EntityVector = typeof entityVectors.$inferSelect;
export type NewEntityVector = typeof entityVectors.$inferInsert;
