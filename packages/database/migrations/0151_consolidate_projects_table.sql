-- Migration: 0151_consolidate_projects_table.sql
--
-- Consolidates the project system from entity-based (profileSlug='project')
-- to table-based (projects pgTable). The `projects` table was never dropped
-- (migration 0022 is a 0-byte no-op), so it still exists.
--
-- Steps:
--   1. Create the projects table if it doesn't exist (fresh pod support)
--   2. Ensure projects table columns exist (defensive)
--   3. Migrate entity rows (profileSlug='project') into the projects table
--   4. Repoint project_members.project_id FK from entities(id) to projects(id)
--   5. Drop FK on relations.target_entity_id (polymorphic endpoint — projects
--      are no longer entities, so the FK would block linkEntityToProject)
--   6. Soft-delete the project entity profile
--
-- Reverse of migration 0134 (project_members repoint to entities).

-- ── 1. Create the projects table if it doesn't exist (fresh pod support) ──────
-- Ensures the table exists when running for the first time on a fresh pod that
-- doesn't have the table from older migrations or the baseline schema.
CREATE TABLE IF NOT EXISTS projects (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  workspace_id uuid,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active',
  settings jsonb,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects (user_id);
CREATE INDEX IF NOT EXISTS projects_status_idx ON projects (status);

-- ── 2. Ensure projects table columns (defensive) ─────────────────────────────
-- The table exists, but ensure all columns are present. On a fresh pod, Step 1
-- creates the full schema. On an existing pod whose projects table was created
-- by a pre-consolidation migration with a narrower schema, these ADD COLUMN
-- statements fill in whatever is missing so the Step 3 INSERT has every column
-- it writes to.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS settings jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS metadata jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- ── 3. Migrate entity-based projects into the projects table ─────────────────
-- Map: entity.title → projects.name, entity.preview → projects.description,
-- entity.properties→status, settings, metadata.
INSERT INTO projects (id, user_id, workspace_id, name, description, status, settings, metadata, created_at, updated_at)
SELECT
  e.id,
  e.user_id,
  e.workspace_id,
  e.title AS name,
  (e.properties->>'description') AS description,
  CASE
    WHEN e.properties->>'status' IN ('active', 'in-progress', 'planning') THEN 'active'
    WHEN e.properties->>'status' = 'done' THEN 'completed'
    WHEN e.properties->>'status' = 'cancelled' THEN 'archived'
    ELSE 'active'
  END AS status,
  COALESCE(e.properties->'settings', '{}'::jsonb) AS settings,
  COALESCE(e.properties->'metadata', '{}'::jsonb) AS metadata,
  e.created_at,
  e.updated_at
FROM entities e
JOIN profiles p ON p.id = e.profile_id
WHERE p.slug = 'project'
  AND NOT EXISTS (SELECT 1 FROM projects pr WHERE pr.id = e.id)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  settings = EXCLUDED.settings,
  metadata = EXCLUDED.metadata;

-- ── 4. Repoint project_members FK: entities(id) → projects(id) ──────────────
-- Reverse the 0134 repoint. Drop the entities FK and add the projects FK.
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_project_id_entities_id_fk;

-- Only add if not already present (defensive on re-run)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'project_members_project_id_projects_id_fk'
  ) THEN
    ALTER TABLE project_members
      ADD CONSTRAINT project_members_project_id_projects_id_fk
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
END; $$;
-- ── 5. Drop FK on relations.source_entity_id / target_entity_id ────────────
-- Both columns reference entities(id), but now projects are table rows (not
-- entities). The partial unique index relations_belongs_to_project_unique
-- (0137) already guards shape; the FK would block linkEntityToProject for new
-- table-based project IDs. Query pg_constraint for the actual names rather than
-- guessing — pre-consolidation pods may have Drizzle-generated names that differ
-- from PostgreSQL defaults.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute attr
      ON attr.attrelid = con.conrelid
     AND attr.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'relations'::regclass
      AND con.contype = 'f'
      AND attr.attname IN ('source_entity_id', 'target_entity_id')
  LOOP
    EXECUTE 'ALTER TABLE relations DROP CONSTRAINT IF EXISTS ' || r.conname;
  END LOOP;
END;
$$;

-- ── 6. Soft-delete the project entity profile ────────────────────────────────
-- Mark the profile inactive so new entities cannot be created with it.
-- Existing entities were migrated in step 3 above.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'is_active') THEN
    UPDATE profiles SET is_active = false WHERE slug = 'project';
  ELSE
    -- If the column doesn't exist yet, the profile just stays — harmless,
    -- the seed script will stop creating it after this migration.
    -- A future migration can add the column and deactivate.
  END IF;
END; $$;
