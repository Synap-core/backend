/**
 * Agent Configs Schema
 *
 * Per-user, per-workspace, per-agent-type configuration overrides.
 * Centralised in the main backend DB so any intelligence service can read
 * user preferences via Hub Protocol without maintaining its own storage.
 *
 * agent_type is a free-form string defined by the intelligence service
 * (e.g. 'assistant', 'research', 'analysis', 'persona-elon').
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces.js";

export const agentConfigs = pgTable(
  "agent_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    userId: text("user_id").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

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
  })
);

export type AgentConfig = typeof agentConfigs.$inferSelect;
export type NewAgentConfig = typeof agentConfigs.$inferInsert;
