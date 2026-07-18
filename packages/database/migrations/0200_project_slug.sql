-- Migration: 0200_project_slug.sql
--
-- P4-lite Wave 0 — cross-pod addressable projects.
-- Adds `projects.slug` (nullable text), backfills it from `name`, and enforces
-- per-user uniqueness with a partial unique index. The slug is the pod-side
-- SSOT that gets mirrored to the Control Plane `pod_projects` directory; refs
-- resolve as bare `slug` (when unique) or fully-qualified `pod/slug`.
--
-- SQL/TS PARITY: the slugify expression below MUST stay behavior-identical to
-- `slugifyProjectName()` in packages/database/src/utils/project-slug.ts (the
-- ONE runtime door):
--   lower(name) → replace every run of [^a-z0-9] with '-' → trim '-' →
--   fallback 'project' when empty. Dedupe per user with '-2', '-3', … suffixes
--   (first row by created_at keeps the bare slug).
--
-- NOTE on the baseline rule: `projects` is NOT created in
-- 0000_baseline_schema.sql (it is created by 0151_consolidate_projects_table.sql,
-- which always runs before this file), so there is no baseline CREATE TABLE to
-- extend. The startup tripwire for this column lives in schema-coherence.ts.

-- ── 1. Column ────────────────────────────────────────────────────────────────
ALTER TABLE projects ADD COLUMN IF NOT EXISTS slug text;

-- ── 2. Backfill (idempotent — only rows with NULL slug) ──────────────────────
WITH base AS (
  SELECT
    id,
    user_id,
    created_at,
    CASE
      WHEN btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-') = ''
        THEN 'project'
      ELSE btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-')
    END AS slug_base
  FROM projects
  WHERE slug IS NULL
),
numbered AS (
  SELECT
    id,
    slug_base,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, slug_base
      ORDER BY created_at, id
    ) AS rn
  FROM base
)
UPDATE projects p
SET slug = CASE WHEN n.rn = 1 THEN n.slug_base ELSE n.slug_base || '-' || n.rn END
FROM numbered n
WHERE p.id = n.id
  AND p.slug IS NULL;

-- ── 3. Per-user uniqueness (partial — NULL slugs stay allowed) ───────────────
CREATE UNIQUE INDEX IF NOT EXISTS projects_user_slug_uniq
  ON projects (user_id, slug)
  WHERE slug IS NOT NULL;
