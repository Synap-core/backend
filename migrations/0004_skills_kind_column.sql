-- Migration 0004: Add kind, scope, agent_types columns to skills table
--
-- Previously the skill type was buried in metadata->>'skillType'.
-- This promotes it to a real, queryable, indexed column.
--
-- kind:        'instruction' (text injected into system prompt)
--              'code'        (JS executed in sandbox — was the implicit default)
-- scope:       'user'        (visible only to the creating user)
--              'workspace'   (visible to all workspace members)
-- agent_types: NULL = applies to all agent types
--              JSON array of strings = scoped to specific agent types
--              e.g. '["assistant","research"]'

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'code'
    CHECK (kind IN ('instruction', 'code'));

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'workspace'
    CHECK (scope IN ('user', 'workspace'));

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS agent_types jsonb;

-- Back-fill kind from metadata.skillType
UPDATE skills
  SET kind = 'instruction'
  WHERE metadata->>'skillType' = 'instruction';

-- Index for fast kind-based filtering (common query: list all instruction skills for a workspace)
CREATE INDEX CONCURRENTLY IF NOT EXISTS skills_kind_idx ON skills (kind);
CREATE INDEX CONCURRENTLY IF NOT EXISTS skills_scope_idx ON skills (scope);
