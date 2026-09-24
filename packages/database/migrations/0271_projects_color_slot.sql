-- 0271 — projects.color_slot
--
-- The desktop shell (2026-09-24) shows each project as a coloured plate on the
-- rail, with the same colour marking its sidebar and home. Relay reads it too.
--
-- A SLOT, NOT A COLOUR. The value is an index 1–12 into the design system's
-- identity palette (`--synap-identity-1..12`, the DTCG tokens in
-- synap-app/packages/core/design-tokens). That palette has a light AND a dark
-- value per slot, tuned for contrast on each ground; a stored hex would be right
-- on one theme and wrong on the other, and would fork the palette per project.
--
-- NULLABLE: every existing project has no slot. A surface with no slot derives
-- one deterministically from the project id, so nothing renders uncoloured and
-- nothing is written just to have a value — the stored slot is only ever the
-- person's explicit choice.
--
-- NOTE: `projects` is created by 0151_consolidate_projects_table.sql, NOT by
-- 0000_baseline_schema.sql, so this column is deliberately NOT added to the
-- baseline (an ALTER there fails 42P01 on a fresh database) — the same
-- exemption as `slug` (0200) and `target_date` (0252). schema-coherence.ts
-- carries this column's only startup guard.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "color_slot" smallint;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_color_slot_range'
  ) THEN
    ALTER TABLE "projects"
      ADD CONSTRAINT "projects_color_slot_range"
      CHECK ("color_slot" IS NULL OR ("color_slot" BETWEEN 1 AND 12));
  END IF;
END $$;
