import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  varchar,
  index,
  sql,
} from "drizzle-orm/pg-core";

/**
 * Knowledge Keys Schema
 *
 * Stores operational documentation for the pod — how to deploy, fix, build.
 * Complements knowledge_facts (per-user episodic memory) with
 * pod-wide procedural knowledge accessible by structured lookup.
 *
 * Key format: `namespace:slug` (e.g. "deploy:backend", "ui:tokens")
 * Scope is workspace-aware — workspace_id is null for pod-wide knowledge,
 * set for workspace-specific knowledge entries.
 */

export const knowledgeKeys = pgTable(
  "knowledge_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    // Unique key: "namespace:slug"
    key: varchar("key", { length: 256 }).notNull().unique(),

    // Extracted for indexing and browsing
    namespace: varchar("namespace", { length: 64 }).notNull(),
    slug: varchar("slug", { length: 128 }).notNull(),

    // Markdown content
    value: text("value").notNull().default(""),

    // Who can see this? null = pod-wide, set = workspace-scoped
    workspaceId: uuid("workspace_id"),

    // Simple version counter
    version: integer("version").notNull().default(1),

    // Lifecycle status
    status: varchar("status", { length: 32 }).notNull().default("active"),

    // Human author (e.g. "antoine", "admin")
    author: varchar("author", { length: 64 }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    // Full-text search index on value (PostgreSQL GIN)
    valueGin: index("idx_knowledge_value_ft").using(
      "gin",
      sql`to_tsvector('simple', ${table.value})`
    ),

    // Browse by namespace
    namespaceIdx: index("idx_knowledge_namespace").on(table.namespace),

    // Filter by status
    statusIdx: index("idx_knowledge_status").on(table.status),

    // Workspace-scoped filtering
    workspaceIdx: index("idx_knowledge_workspace").on(table.workspaceId),
  })
);

export type KnowledgeKeyRow = typeof knowledgeKeys.$inferSelect;
export type NewKnowledgeKeyRow = typeof knowledgeKeys.$inferInsert;
