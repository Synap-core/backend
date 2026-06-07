-- 0107_provenance_columns.sql
-- Wave B3 — uniform provenance on the knowledge-graph core (entities, documents,
-- relations). Additive + NULLABLE; legacy rows = NULL (treated as human/owner).
--
-- Columns:
--   created_by_kind    text   ('human' | 'ai_agent' | 'system')
--   created_by_user_id text   FK -> users(id)  ON DELETE SET NULL  (Kratos ids are text)
--   agent_user_id      text   FK -> users(id)  ON DELETE SET NULL
--   source_proposal_id uuid   FK -> proposals(id) ON DELETE SET NULL
--   correlation_id     uuid   (no FK; matches proposals.correlation_id / events.correlation_id)

-- ── columns ──────────────────────────────────────────────────────────────────
ALTER TABLE entities  ADD COLUMN IF NOT EXISTS created_by_kind    text;
ALTER TABLE entities  ADD COLUMN IF NOT EXISTS created_by_user_id text;
ALTER TABLE entities  ADD COLUMN IF NOT EXISTS agent_user_id      text;
ALTER TABLE entities  ADD COLUMN IF NOT EXISTS source_proposal_id uuid;
ALTER TABLE entities  ADD COLUMN IF NOT EXISTS correlation_id     uuid;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_by_kind    text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS created_by_user_id text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS agent_user_id      text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_proposal_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS correlation_id     uuid;

ALTER TABLE relations ADD COLUMN IF NOT EXISTS created_by_kind    text;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS created_by_user_id text;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS agent_user_id      text;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS source_proposal_id uuid;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS correlation_id     uuid;

-- ── foreign keys (idempotent) ────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entities','documents','relations'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_created_by_user_id_fkey') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL', t, t || '_created_by_user_id_fkey');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_agent_user_id_fkey') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (agent_user_id) REFERENCES users(id) ON DELETE SET NULL', t, t || '_agent_user_id_fkey');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_source_proposal_id_fkey') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (source_proposal_id) REFERENCES proposals(id) ON DELETE SET NULL', t, t || '_source_proposal_id_fkey');
    END IF;
  END LOOP;
END $$;

-- ── indexes (partial — only non-null provenance rows) ────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entities','documents','relations'] LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (agent_user_id)      WHERE agent_user_id      IS NOT NULL', t || '_agent_user_id_idx',      t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (correlation_id)     WHERE correlation_id     IS NOT NULL', t || '_correlation_id_idx',     t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (source_proposal_id) WHERE source_proposal_id IS NOT NULL', t || '_source_proposal_id_idx', t);
  END LOOP;
END $$;
