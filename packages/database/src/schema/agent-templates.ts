/**
 * Agent Templates (0404) — ONE row per AI program the pod knows (Claude Code,
 * Codex, Hermes…), installed pod-wide by the catalog kind `agent` (founder
 * decision D8). Each column is a field of the catalog's `definition.agent`
 * (`AgentTemplateSpec`, @synap-core/types/agents), so a template update is a
 * per-field keep/drop diff against `metadata.marketSource.baseline`.
 *
 * An agent links to its template by `users.agent_template_slug` (= `slug`,
 * no FK: an agent can exist before its template is installed). `harness` is
 * the `users.agent_type` of its agents.
 */

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AgentTemplateDetect,
  AgentTemplateWake,
} from "@synap-core/types/agents";

export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** The catalog package slug (unique on the pod). */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** = `users.agent_type` of this program's agents. */
    harness: text("harness").notNull(),
    /** Other `agent_type` spellings that clearly mean this program. */
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    /** Can it run handed work headless (be a worker). */
    worker: boolean("worker").notNull().default(false),
    /** false = its wake was never run on a real computer (a stub). */
    tried: boolean("tried").notNull().default(false),
    detect: jsonb("detect").$type<AgentTemplateDetect | null>(),
    /** How a computer starts it on handed work; null = it cannot be started. */
    wake: jsonb("wake").$type<AgentTemplateWake | null>(),
    practices: jsonb("practices")
      .$type<{ skills: string[] }>()
      .notNull()
      .default({ skills: [] }),
    /** Holds `marketSource` (the catalog source link + install baseline). */
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_templates_slug_unique").on(t.slug),
    index("agent_templates_harness_idx").on(t.harness),
  ]
);

export type AgentTemplateRow = typeof agentTemplates.$inferSelect;
