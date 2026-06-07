-- Add role column to widget_definitions to formally distinguish widget kinds.
--
-- Values:
--   widget          → bento widget / add-block picker item (default, all existing rows)
--   view-renderer   → renders a view type (e.g. custom kanban board)
--   entity-renderer → renders a profile's entity detail
--   panel           → side/floating panel surface
--
-- The DEFAULT means all existing rows (builtin widgets) get 'widget' automatically.

ALTER TABLE "widget_definitions" ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'widget';
