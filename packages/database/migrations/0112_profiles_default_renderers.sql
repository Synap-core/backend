-- 0112: profiles — collapse the three per-slot renderer columns into ONE
-- `default_renderers` jsonb map keyed by RendererType. There are no longer
-- separate "slots" — a profile assigns one renderer per renderer type.
--
--   default_detail_renderer    → default_renderers->'entity-detail'
--   default_dashboard_renderer → default_renderers->'entity-profile'
--   default_list_renderer      → default_renderers->'collection'
--
-- Each value is a RendererTarget ({kind:'cell',cellKey} | {kind:'view',viewId} | …).
-- The old columns are KEPT for transition (deprecated; a later migration drops
-- them once the new path is verified in production).

ALTER TABLE "profiles"
  ADD COLUMN IF NOT EXISTS "default_renderers" jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE "profiles" SET "default_renderers" = jsonb_strip_nulls(
  jsonb_build_object(
    'entity-detail',  "default_detail_renderer",
    'entity-profile', "default_dashboard_renderer",
    'collection',     "default_list_renderer"
  )
)
WHERE "default_renderers" = '{}'::jsonb;
