-- Intelligence Commands: user-created prompt templates with derived inputs and permissions.

CREATE TABLE IF NOT EXISTS intelligence_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,

  title TEXT NOT NULL,
  prompt_template TEXT NOT NULL,
  compiled_template_ast JSONB,
  derived_inputs JSONB,
  input_overrides JSONB,

  allowed_tools JSONB,
  allowed_entity_types JSONB,
  max_entities_created_per_run INTEGER,
  can_create_views BOOLEAN NOT NULL DEFAULT false,
  output_mode TEXT NOT NULL DEFAULT 'text' CHECK (output_mode IN ('text', 'proposal', 'view')),
  permissions_profile TEXT NOT NULL DEFAULT 'propose_writes' CHECK (permissions_profile IN ('read_only', 'propose_writes')),

  shared_scope TEXT NOT NULL DEFAULT 'workspace' CHECK (shared_scope IN ('workspace', 'user')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS intelligence_commands_workspace_id_idx ON intelligence_commands (workspace_id);
CREATE INDEX IF NOT EXISTS intelligence_commands_created_by_idx ON intelligence_commands (created_by);
