-- 0171_channels_project_id.sql
--
-- Project lens for channels: adds a nullable `project_id` scope column to
-- `channels` so the Room UI can filter conversation surfaces by the active
-- PROJECT lens (cross-cutting), independently of `workspace_id` (domain lens).
--
-- Nullable — ordinary channels and pod/workspace surfaces leave it NULL.
-- ON DELETE SET NULL so deleting a project detaches its rooms rather than
-- cascading them away. Mirrors views.project_id (0166), except channels use
-- SET NULL (a channel outlives its project tag) rather than CASCADE.

ALTER TABLE "channels"
  ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "channels_project_id_idx"
  ON "channels" ("project_id");
