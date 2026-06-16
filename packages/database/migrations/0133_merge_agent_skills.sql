-- 0133_merge_agent_skills.sql
--
-- Merges the agent_skills table into the skills table. agent_skills = doc-style
-- know-how (slug, body, topics, source, author, version, tags); skills =
-- executable capabilities (kind, code, parameters, etc.). After the merge, ONE
-- skills table serves both use-cases. Doc-style skills set kind='instruction'
-- with body populated; executable skills set kind='code' with code populated.
--
-- Defensive + idempotent: every DDL uses IF NOT EXISTS / IF EXISTS.
-- Data migration: INSERT rows from agent_skills whose slug does NOT already
-- exist in skills (no dedup collision is expected — the tables serve different
-- domains — but the guard keeps the migration re-runnable).
--
-- Runs inside the migration runner's transaction.

-- 1. Add new columns to skills (from agent_skills)
ALTER TABLE skills ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS topics text[] DEFAULT '{}';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS author text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS version text;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS tags text[] DEFAULT '{}';

-- 2. Relax NOT NULL on skills.code — doc-style skills have no code
ALTER TABLE skills ALTER COLUMN code DROP NOT NULL;

-- 3. Create unique index on slug (was idx_agent_skills_slug on agent_skills)
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug ON skills (slug) WHERE slug IS NOT NULL;

-- 4. Create topics index (was idx_agent_skills_topics)
CREATE INDEX IF NOT EXISTS idx_skills_topics ON skills USING GIN (topics);

-- 5. Migrate data: copy agent_skills rows that do NOT already have a matching
--    slug in skills (idempotent guard)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'agent_skills' AND table_schema = current_schema()
  ) THEN
    INSERT INTO skills (
      slug, name, description, body, topics, source, author, version, tags,
      kind, scope, code, user_id, status, created_at, updated_at
    )
    SELECT
      ag.slug,
      ag.name,
      ag.description,
      ag.body,
      COALESCE(ag.topics, '{}'),
      ag.source,
      ag.author,
      ag.version,
      COALESCE(ag.tags, '{}'),
      'instruction',                -- doc-style → kind='instruction'
      'pod'::text,                  -- agent_skills rows were pod-scoped
      ag.body,                      -- copy body into code column for backward compat
      'system',                     -- user_id placeholder for migrated rows
      'active',
      ag.created_at,
      ag.updated_at
    FROM agent_skills ag
    WHERE ag.slug NOT IN (
      SELECT s.slug FROM skills s WHERE s.slug IS NOT NULL
    );
  END IF;
END $$;

-- 6. Drop the agent_skills table
DROP TABLE IF EXISTS agent_skills CASCADE;
