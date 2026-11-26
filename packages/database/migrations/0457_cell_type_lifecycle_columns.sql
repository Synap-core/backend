-- Migration: 0457_cell_type_lifecycle_columns.sql
--
-- ONE CELL TYPE REGISTRY (Surfaces P5, audit appendix B §4 Q3). The code
-- catalog's cell type (`CellTypeDef`, `@synap-core/types/renderables`) carries
-- a markdown fallback and its placements; a stored cell type
-- (`widget_definitions`) did not, and its lifecycle was a boolean. The row
-- gains the same fields:
--
--   status        text  NOT NULL DEFAULT 'active'
--                       draft | proposed | active | retired. Backfilled from
--                       is_active (false → retired). The writers that flip
--                       is_active write status with it; is_active stays the
--                       column every reader filters on until they move.
--   fallback      text  the markdown a host without the cell shows (relay,
--                       exports, other agents). NULL = none declared.
--   placements    jsonb the bodies it may be placed in (`Placement[]`:
--                       bento, page, side, inline, floating). NULL = no
--                       narrowing (every placement).
--   anchor_kinds  jsonb the objects it may be anchored to (`AnchorKind[]`,
--                       `@synap-core/types/surfaces`). NULL = any.
--
-- Nullable columns and one constant default: catalog-only on Postgres >= 11.
-- The backfill touches only the retired rows. Idempotent.

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active';
ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "fallback" text;
ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "placements" jsonb;
ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "anchor_kinds" jsonb;

UPDATE "widget_definitions"
  SET "status" = 'retired'
  WHERE "is_active" = false AND "status" = 'active';
