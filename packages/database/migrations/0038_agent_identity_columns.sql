-- 0038_agent_identity_columns.sql
--
-- Promote the agent-identity fields trapped in users.agent_metadata (JSONB) to
-- real, typed, indexed, FK-enforced columns. The JSONB blob is KEPT and
-- dual-written during the transition; query predicates move to the columns.
--
-- FK-safe: created_by_user_id / parent_agent_id are kept only when they point at
-- a real user — the 'system' sentinel and any orphans become NULL (the JSONB
-- still carries the original value for back-compat).
--
-- The 0037 partial-unique firewall stays as-is (expression indexes over the
-- blob); it remains the duplicate backstop while the blob is dual-written.

ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_user_id text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_personal_agent  boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_template     text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_type         text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS parent_agent_id    text;

-- Backfill from the blob (agent rows only).
UPDATE users SET
  created_by_user_id = CASE
    WHEN (agent_metadata->>'createdByUserId') IN (SELECT id FROM users u2)
    THEN agent_metadata->>'createdByUserId' ELSE NULL END,
  is_personal_agent  = COALESCE((agent_metadata->>'isPersonalAgent') = 'true', false),
  agent_template     = agent_metadata->>'agentTemplate',
  agent_type         = agent_metadata->>'agentType',
  parent_agent_id    = CASE
    WHEN (agent_metadata->>'parentAgentId') IN (SELECT id FROM users u3)
    THEN agent_metadata->>'parentAgentId' ELSE NULL END
WHERE user_type = 'agent';

-- Foreign keys (ON DELETE SET NULL — orphan-safe). Idempotent.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_created_by_user_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_created_by_user_id_fkey
      FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_parent_agent_id_fkey') THEN
    ALTER TABLE users ADD CONSTRAINT users_parent_agent_id_fkey
      FOREIGN KEY (parent_agent_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_agent_type
  ON users (agent_type) WHERE user_type = 'agent';
CREATE INDEX IF NOT EXISTS idx_users_created_by_user_id
  ON users (created_by_user_id) WHERE user_type = 'agent';
CREATE INDEX IF NOT EXISTS idx_users_parent_agent_id
  ON users (parent_agent_id) WHERE user_type = 'agent';
