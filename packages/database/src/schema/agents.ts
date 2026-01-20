/**
 * Agents Schema
 *
 * Configuration for AI agents (system and user-created).
 * Defines LLM provider, capabilities, and execution parameters.
 */

import {
  pgTable,
  text,
  timestamp,
  jsonb,
  integer,
  decimal,
  boolean,
  index,
} from "drizzle-orm/pg-core";

export const agents = pgTable(
  "agents",
  {
    // Identity
    id: text("id").primaryKey(), // 'orchestrator', 'research-agent', 'user-custom-123'
    name: text("name").notNull(),
    description: text("description"),

    // Ownership
    createdBy: text("created_by").notNull(), // 'system' | user-id
    userId: text("user_id"), // NULL for system agents

    // LLM Configuration
    llmProvider: text("llm_provider", {
      enum: ["claude", "openai", "ollama", "gemini"],
    })
      .notNull()
      .default("claude"),
    llmModel: text("llm_model").notNull(), // 'claude-3-7-sonnet-20250219'

    // Agent definition
    capabilities: text("capabilities").array().notNull(), // ['intent_analysis', 'entity_extraction']
    systemPrompt: text("system_prompt").notNull(),
    toolsConfig: jsonb("tools_config"), // Tool definitions

    // Execution
    executionMode: text("execution_mode", {
      enum: ["simple", "react", "langgraph"],
    })
      .notNull()
      .default("simple"),
    maxIterations: integer("max_iterations").default(5),
    timeoutSeconds: integer("timeout_seconds").default(30),

    // Learning (V2 feature - placeholder for now)
    weight: decimal("weight", { precision: 5, scale: 2 }).default("1.0"),
    performanceMetrics: jsonb("performance_metrics"),

    // Status
    active: boolean("active").notNull().default(true),

    // Timestamps
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    createdByIdx: index("agents_created_by_idx").on(table.createdBy),
    userIdIdx: index("agents_user_id_idx").on(table.userId),
    activeIdx: index("agents_active_idx").on(table.active),
  })
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
