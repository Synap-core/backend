-- 0322: template tombstones in the pod catalog cache (TEMPLATE-LIFECYCLE
-- Contract A). The catalog sync for kind='template' now asks the CP for
-- `includeRetired=true`, so a template that LEFT the catalog stays known with
-- why and what replaced it. Template health reads these to tell "retired,
-- replaced by X" apart from "never heard of it". Every browse/install reader
-- filters `retired_at IS NULL`, so a retired row is never offered or installed.
-- An older CP that ignores the param returns no retired rows: all three stay
-- NULL and behaviour is exactly today's.

ALTER TABLE "cp_catalog_cache" ADD COLUMN IF NOT EXISTS "retired_at" timestamptz;
ALTER TABLE "cp_catalog_cache" ADD COLUMN IF NOT EXISTS "replaced_by_slug" text;
ALTER TABLE "cp_catalog_cache" ADD COLUMN IF NOT EXISTS "retired_reason" text;
