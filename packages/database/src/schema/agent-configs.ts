/**
 * Agent Configs Schema
 *
 * Per-user, per-workspace, per-agent-type configuration overrides.
 * Centralised in the main backend DB so any intelligence service can read
 * user preferences via Hub Protocol without maintaining its own storage.
 *
 * agent_type is a free-form string defined by the intelligence service
 * (e.g. 'assistant', 'research', 'analysis', 'persona-elon').
 *
 * PRESETS (0390): a row with a `preset_key` is a named way an agent runs for a
 * purpose (a role: reviewer, video editor). It belongs to the agent user
 * (`user_id`), pod-wide (`workspace_id` is NULL, enforced by a CHECK), one per
 * key. Its harness and computer are the agent's own (`users.agent_type`,
 * `users.host_user_id`), never stored again here; its model and provider are
 * DEFAULTS, while what a run used stays a per-run fact (0389). The row with no
 * `preset_key` keeps its meaning: the IS's per-workspace override.
 */

import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),

    /** Free-form agent type string defined by the intelligence service */
    agentType: text("agent_type").notNull(),

    /** Text appended to the agent's system prompt */
    promptAppend: text("prompt_append"),

    /** Additional tool IDs to enable beyond the agent's default set */
    extraToolIds: jsonb("extra_tool_ids")
      .$type<string[]>()
      .default([])
      .notNull(),

    /** Tool IDs to disable from the agent's default set */
    disabledToolIds: jsonb("disabled_tool_ids")
      .$type<string[]>()
      .default([])
      .notNull(),

    /** Override max tool-use steps (null = use agent default) */
    maxStepsOverride: integer("max_steps_override"),

    /** Override the LLM model (null = use agent default) */
    modelOverride: text("model_override"),

    /** A preset's key (a slug, unique per agent); null = not a preset (0390). */
    presetKey: text("preset_key"),
    /** How a person calls the preset (0390). */
    presetLabel: text("preset_label"),
    /** A preset's default provider, a MODEL_PROVIDERS slug (0390). */
    providerOverride: text("provider_override"),
    /** Skill slugs a preset loads (0390). */
    skillSlugs: jsonb("skill_slugs").$type<string[]>().default([]).notNull(),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => ({
    uniqueUserWorkspaceAgent: unique(
      "agent_configs_user_workspace_agent_unique"
    ).on(table.userId, table.workspaceId, table.agentType),
    userIdIdx: index("agent_configs_user_id_idx").on(table.userId),
    workspaceIdIdx: index("agent_configs_workspace_id_idx").on(
      table.workspaceId
    ),
    agentTypeIdx: index("agent_configs_agent_type_idx").on(table.agentType),
    // One preset per key per agent (0390); the preset upsert conflicts on it.
    userPresetUnique: uniqueIndex("agent_configs_user_preset_unique")
      .on(table.userId, table.presetKey)
      .where(sql`${table.presetKey} IS NOT NULL`),
  })
);

export type AgentConfig = typeof agentConfigs.$inferSelect;
export type NewAgentConfig = typeof agentConfigs.$inferInsert;
