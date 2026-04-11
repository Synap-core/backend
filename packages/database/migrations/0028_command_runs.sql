-- Command Runs: audit log for command executions; every run has a thread_id (provenance).

CREATE TABLE IF NOT EXISTS command_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  command_id UUID NOT NULL REFERENCES intelligence_commands(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  user_id TEXT NOT NULL,

  permissions_snapshot JSONB,
  inputs JSONB,
  selection_context_snapshot JSONB,
  output_summary TEXT,
  proposed_actions JSONB,
  approved_actions JSONB,

  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS command_runs_command_id_idx ON command_runs (command_id);
CREATE INDEX IF NOT EXISTS command_runs_workspace_id_idx ON command_runs (workspace_id);
CREATE INDEX IF NOT EXISTS command_runs_user_id_idx ON command_runs (user_id);
CREATE INDEX IF NOT EXISTS command_runs_thread_id_idx ON command_runs (thread_id);
CREATE INDEX IF NOT EXISTS command_runs_started_at_idx ON command_runs (started_at);
