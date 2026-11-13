-- 0423 — projects.main_goal_id: the project's MAIN GOAL (founder decision,
-- 2026-11-12, goals / pillars / health contract §2).
--
-- An EXPLICIT pointer from a project to ONE of its own live goals
-- (`project_tracks`). Written only through the governed project update
-- (`updateProjectGoverned`, `mainGoalId`), which checks that the goal belongs
-- to this project, is visible to the writer and is live. NULL = no main goal
-- named.
--
-- A typed column, not a `settings` JSONB key (same reason as 0347): the
-- foreign key keeps the pointer honest by itself — deleting the goal clears it
-- (ON DELETE SET NULL), where a JSONB key would point at a row that no longer
-- exists and every reader would have to guard it.
--
-- NOTE: `projects` is created by 0151_consolidate_projects_table.sql and
-- `project_tracks` by 0272_project_tracks.sql, NOT by 0000_baseline_schema.sql,
-- so this column is deliberately NOT added to the baseline (an ALTER there
-- fails 42P01 on a fresh database) — the same exemption as `slug` (0200),
-- `target_date` (0252), `color_slot` (0271), `icon` (0328) and `sample`
-- (0347). schema-coherence.ts carries this column's only startup guard.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "main_goal_id" uuid
  REFERENCES "project_tracks"("id") ON DELETE SET NULL;
