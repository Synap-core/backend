-- 0252 — projects.target_date
--
-- A project is the pod's only LONG-HORIZON object, and it had no date at all:
-- name, description, slug, status, phase, settings, metadata. Without a date
-- nothing can be LATE, so a project can only ever be green — the failure mode
-- every goal/OKR layer dies of. `target_date` is the one field that lets a
-- months-long piece of work go red.
--
-- NULLABLE, and that is load-bearing, not laziness:
--   1. Every existing row has no date and must stay valid.
--   2. The Control Plane MIRRORS projects (`pod_projects`, pushed by
--      jobs/src/workers/cp-project-sync.ts). That mirror is "an accelerator,
--      never an authority" and its insert does not carry this column; a NOT NULL
--      here would break the sync. The CP contract is deliberately unchanged —
--      the sync selects an explicit column list (cp-project-sync.ts:167-172),
--      so this column is invisible to it.
--   3. Not every project HAS a deadline. A project with no target date is not
--      late — it is undated, which is a different (and honest) statement.
--
-- NO `progress` / `health` column, deliberately. Both are DERIVED — from the
-- contained work and from `target_date` vs now(). A stored percentage is a
-- number nobody recomputes; see the `phase` column comment (0240), which already
-- records this rule for this same table.
--
-- Type is `timestamptz`, matching EVERY other timestamp in this schema (there is
-- not one `date` column in the pod). Day-granularity is a RENDERING concern: the
-- surface shows the date in the viewer's zone, and "late" is `target_date < now()`.
--
-- NOTE: `projects` is created by 0151_consolidate_projects_table.sql, NOT by
-- 0000_baseline_schema.sql, so this column is deliberately NOT added to the
-- baseline — an ALTER there fails 42P01 on a fresh database. The baseline records
-- that exemption in its own comment (0000_baseline_schema.sql, the
-- "projects.phase is NOT declared here" note). schema-coherence.ts carries this
-- column's only startup guard, exactly like `projects.slug` (0200).

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "target_date" timestamp with time zone;

-- The "what is late / what is due soon" read: a horizon scan over live projects.
-- Partial on NOT NULL because an undated project can never satisfy the predicate
-- and has no business in the index.
CREATE INDEX IF NOT EXISTS "projects_target_date_idx"
  ON "projects" ("target_date")
  WHERE "target_date" IS NOT NULL;
