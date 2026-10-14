-- 0328 — projects.icon
--
-- Projects are PLACES now (2026-10-14): the rail draws each one as its colour
-- plate (`color_slot`, 0271) with a mark on it. The mark is the person's
-- choice of ONE emoji or a lucide glyph, stored in ONE string:
--   - an emoji grapheme ("🚀", "👩‍👩‍👧"), or
--   - `glyph:<lucide-name>` ("glyph:rocket").
-- The shape is checked on write by `isProjectIcon` (@synap-core/types/projects),
-- the one parser every surface reads with; the database only bounds the length.
--
-- NULLABLE: no project has an icon yet, and none is invented — a surface with
-- no icon draws the project's initials on its colour plate.
--
-- NOTE: `projects` is created by 0151_consolidate_projects_table.sql, NOT by
-- 0000_baseline_schema.sql, so this column is deliberately NOT added to the
-- baseline (an ALTER there fails 42P01 on a fresh database) — the same
-- exemption as `slug` (0200), `target_date` (0252) and `color_slot` (0271).
-- schema-coherence.ts carries this column's only startup guard.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "icon" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_icon_length'
  ) THEN
    ALTER TABLE "projects"
      ADD CONSTRAINT "projects_icon_length"
      CHECK ("icon" IS NULL OR char_length("icon") BETWEEN 1 AND 64);
  END IF;
END $$;
