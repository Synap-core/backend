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

-- Step 0: ensure the table exists before repointing it.
-- `project_members` is created in 0000_baseline_schema.sql, but that catch-up
-- file only runs on FIRST boot. A pod provisioned BEFORE the table entered the
-- baseline has 0000 already marked applied — so the table is never created and
-- the repoint steps below fail with "relation does not exist" (PG 42P01).
-- Defensive-migration rule: never assume a table exists. Create it IF NOT EXISTS
-- here (verbatim from baseline, FK already to entities) so this migration is
-- self-sufficient on every pod. Fresh/baseline pod → no-op. Legacy pod (FK to
-- projects) → table exists already and Steps B/C repoint it.
CREATE TABLE IF NOT EXISTS "project_members" (
  "id"          uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id"  uuid        NOT NULL CONSTRAINT "project_members_project_id_entities_id_fk"
                              REFERENCES "entities"("id") ON DELETE CASCADE,
  "user_id"     text        NOT NULL,
  "role"        text        NOT NULL DEFAULT 'viewer',
  "invited_by"  text,
  "invited_at"  timestamptz NOT NULL DEFAULT now(),
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "project_user_unique" UNIQUE ("project_id", "user_id")
);
CREATE INDEX IF NOT EXISTS "idx_project_members_project"
  ON "project_members" ("project_id");
CREATE INDEX IF NOT EXISTS "idx_project_members_user"
  ON "project_members" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_project_members_user_project"
  ON "project_members" ("user_id", "project_id");

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
