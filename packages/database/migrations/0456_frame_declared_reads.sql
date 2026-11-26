-- Migration: 0456_frame_declared_reads.sql
--
-- DECLARED READS (Surfaces P6a). A framed surface (a cell type, an HTML page)
-- may declare the reads it makes, a subset of the one ceiling table
-- `CELL_BRIDGE_READ_OPS` (`@synap-core/types/cell-bridge`). The pod's one frame
-- read door (`surfaces.frameRead`, Hub `POST /frame/read`) refuses a read
-- outside the declaration and logs every call.
--
--   widget_definitions.reads   jsonb  the cell type's declared reads
--   widget_definitions.writes  jsonb  the cell type's declared writes (stored;
--                                      the hosts check them, the server does
--                                      not enforce them yet)
--   frame_read_log                    one row per frame read, answered or refused
--
-- An HTML page declares its reads in `documents.metadata.reads` (no column:
-- only pages carry it, and `metadata` is the document's own free jsonb).
--
-- NULL = the surface declares nothing: every ceiling read is still answered
-- (backward compatible) and logged `declared = false`. No backfill: nothing
-- declared before this migration.
--
-- Nullable columns with no default: a catalog-only change on Postgres >= 11.
-- The log has no foreign key on purpose (an append log that outlives the
-- surface and the person it names). Idempotent.

ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "reads" jsonb;
ALTER TABLE "widget_definitions"
  ADD COLUMN IF NOT EXISTS "writes" jsonb;

CREATE TABLE IF NOT EXISTS "frame_read_log" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      text NOT NULL,
  "workspace_id" uuid,
  "surface_kind" text NOT NULL,
  "surface_key"  text NOT NULL,
  "op"           text NOT NULL,
  "params_hash"  text NOT NULL,
  "allowed"      boolean NOT NULL,
  "declared"     boolean NOT NULL,
  "at"           timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "frame_read_log_surface_idx"
  ON "frame_read_log" ("surface_kind", "surface_key", "at");
CREATE INDEX IF NOT EXISTS "frame_read_log_user_idx"
  ON "frame_read_log" ("user_id", "at");
