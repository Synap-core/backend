-- Add kind, scope, agent_types columns to skills table
-- kind: 'instruction' (system prompt injection) or 'code' (JS function body)
-- scope: 'user' (private) or 'workspace' (shared across workspace)
-- agent_types: which agent types can use this skill (null = all)

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'instruction'
    CHECK (kind IN ('instruction', 'code')),
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'user'
    CHECK (scope IN ('user', 'workspace')),
  ADD COLUMN IF NOT EXISTS agent_types JSONB;

CREATE INDEX IF NOT EXISTS skills_kind_idx ON skills (kind);
CREATE INDEX IF NOT EXISTS skills_scope_idx ON skills (scope);
