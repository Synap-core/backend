-- Migration 0005: Create agent_configs table
--
-- Moves agent configuration (custom instructions, tool overrides, model override)
-- from the Intelligence Hub's local storage into the centralised backend database.
--
-- This means:
--   - Any intelligence service can read a user's agent preferences via Hub Protocol
--   - Configs survive intelligence service restarts / replacements
--   - Standard tRPC CRUD (no proxy hop to hub)
--
-- Keyed by (user_id, workspace_id, agent_type) — agent_type is a free-form string
-- defined by each intelligence service (e.g. 'assistant', 'research', 'analysis').

CREATE TABLE IF NOT EXISTS agent_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text NOT NULL,
  workspace_id    uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_type      text NOT NULL,

  -- System prompt append (injected after the agent's base system prompt)
  prompt_append   text,

  -- Tool ID overrides
  extra_tool_ids    jsonb NOT NULL DEFAULT '[]',
  disabled_tool_ids jsonb NOT NULL DEFAULT '[]',

  -- Execution overrides
  max_steps_override integer,
  model_override     text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE(user_id, workspace_id, agent_type)
);

CREATE INDEX IF NOT EXISTS agent_configs_user_id_idx        ON agent_configs (user_id);
CREATE INDEX IF NOT EXISTS agent_configs_workspace_id_idx   ON agent_configs (workspace_id);
CREATE INDEX IF NOT EXISTS agent_configs_agent_type_idx     ON agent_configs (agent_type);
