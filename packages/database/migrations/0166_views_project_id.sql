-- 0166_views_project_id.sql
--
-- Scoped surfaces: a canonical whiteboard / home / bento per LENS (workspace,
-- project, or session). Adds a nullable `project_id` scope column to `views` so a
-- surface can be pinned to a project lens (cross-cutting), independently of its
-- `workspace_id` (domain lens). Session scope is ephemeral and lives in
-- `metadata` (no column).
--
-- The marked canonical surface (metadata.scopedSurface = true) is unique per
-- (type, workspace_id, project_id) so a lens resolves to exactly ONE home/main
-- board — while ORDINARY user-created boards (no marker) remain unconstrained
-- (many per workspace is normal).

ALTER TABLE "views"
  ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "views_project_id_idx"
  ON "views" ("project_id");

-- One canonical scoped surface per (type, workspace_id, project_id) for MARKED
-- surfaces only. COALESCE the nullable scope columns to a sentinel UUID so NULL
-- workspace / NULL project participate in uniqueness (Postgres treats NULLs as
-- distinct by default, which would silently allow duplicate pod-wide / bare
-- surfaces).
CREATE UNIQUE INDEX IF NOT EXISTS "views_scoped_surface_uniq_idx"
  ON "views" (
    "type",
    COALESCE("workspace_id", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("project_id",   '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE ("metadata"->>'scopedSurface') = 'true';
