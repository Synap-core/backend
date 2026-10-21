-- 0347 — projects.sample (FB1020 B5, founder-approved 2026-10-21)
--
-- A SAMPLE project holds demo data: the records filed into it (and its subject
-- entity) are left out of every LISTING — lists, counts, views, recall, graph,
-- phone search — by the ONE listing rule `listableEntityWhere` (@synap/database
-- utils/listable-entity.ts). They stay readable and editable by id, and opening
-- the project (its project lens) shows them: the lens IS the toggle.
--
-- A record filed into a sample project AND into any non-sample project is REAL
-- (real membership wins — never hide real data). Events from a sample record
-- fire only automations scoped to that sample project.
--
-- A typed column, not a `settings` JSONB key: a JSONB marker is how the probe
-- and template-example flags ended up read by 6 doors out of ~40.
--
-- NOTE: `projects` is created by 0151_consolidate_projects_table.sql, NOT by
-- 0000_baseline_schema.sql, so this column is deliberately NOT added to the
-- baseline (an ALTER there fails 42P01 on a fresh database) — the same
-- exemption as `slug` (0200), `target_date` (0252), `color_slot` (0271) and
-- `icon` (0328). schema-coherence.ts carries this column's only startup guard.

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "sample" boolean NOT NULL DEFAULT false;
