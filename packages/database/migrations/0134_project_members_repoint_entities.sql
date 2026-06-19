-- Migration: 0134_project_members_repoint_entities.sql
--
-- Repoint project_members.project_id FK from the legacy `projects` table
-- to the `entities` table.
--
-- Context: Projects are now first-class entities (profileSlug = 'project').
-- The legacy `projects` table is being deprecated. Any membership row that
-- still points at a legacy projects.id that has no corresponding entities row
-- is orphaned data — delete it before adding the new FK so the constraint
-- does not block.
--
-- Design doc: synap-app/synap-team-docs/content/team/platform/project-centric-scope.mdx
-- Phase: project-centric-scope Phase 0

-- Step A: remove orphaned rows that cannot satisfy the new FK.
-- These are rows whose project_id exists in the legacy projects table but has
-- no corresponding entity row (projects migrated to entities get a matching id).
-- NOT EXISTS (not NOT IN) — NULL-safe and idiomatic for defensive migrations:
-- NOT IN against a subquery silently deletes nothing if the subquery ever yields
-- a NULL, whereas NOT EXISTS expresses "no matching entity row" unambiguously.
DELETE FROM project_members pm
WHERE NOT EXISTS (
  SELECT 1 FROM entities e WHERE e.id = pm.project_id
);

-- Step B: drop the existing FK to projects(id) defensively.
-- The constraint was created by drizzle-kit push; both likely names are tried
-- so the DROP is safe on re-runs and on pods where the name differs.
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_project_id_projects_id_fk;
ALTER TABLE project_members DROP CONSTRAINT IF EXISTS project_members_project_id_fkey;

-- Step C: add the new FK to entities(id) ON DELETE CASCADE, idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE constraint_name = 'project_members_project_id_entities_id_fk'
       AND table_name = 'project_members'
  ) THEN
    ALTER TABLE project_members
      ADD CONSTRAINT project_members_project_id_entities_id_fk
      FOREIGN KEY (project_id) REFERENCES entities(id) ON DELETE CASCADE;
  END IF;
END; $$;
