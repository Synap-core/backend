-- 0111: widget_definitions — add `content_kind`, the single de-conflated
-- taxonomy for WHAT a cell renders. Replaces the conflated `role`.
--
-- NOTE: this is DISTINCT from the existing `renderer_type` column, which is the
-- rendering MECHANISM (frame | builtin | iframe | native) — orthogonal. Do NOT
-- touch renderer_type here.
--
-- contentKind = entity-detail | entity-profile | collection | widget
-- (`widget` is the content-agnostic default; never a profile assignment).
--
-- `role` (Track B) is KEPT for transition (deprecated; dropped in a later
-- migration). Backfill maps the legacy values; `panel` was a PLACEMENT not a
-- content type → collapses to `widget`; `entity-profile` is NEW (no legacy role
-- maps to it — set explicitly on profile-level cells).

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "content_kind" text NOT NULL DEFAULT 'widget';

UPDATE "widget_definitions" SET "content_kind" = CASE "role"
  WHEN 'entity-renderer' THEN 'entity-detail'
  WHEN 'view-renderer'   THEN 'collection'
  WHEN 'panel'           THEN 'widget'
  ELSE 'widget'
END;
