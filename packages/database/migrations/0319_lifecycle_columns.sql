-- 0319: the lifecycle columns (work model L1/L2, founder W12–W14, 2026-10-11).
--
-- A kind's status lives in `entities.status` + `entities.status_category`; a
-- role's in `entity_facets.status` (exists since 0174) + the new
-- `entity_facets.status_category`. These COLUMNS are the truth. The JSONB copy
-- `properties[<lifecycle slug>]` is the READ PROJECTION, written through only
-- by the `moveStatus` door, so every existing reader keeps working.
--
-- `profile_properties.is_lifecycle` marks WHICH property of a profile is its
-- lifecycle; the partial unique index makes "one lifecycle per kind or role"
-- a database fact, not a convention.
--
-- Categories are FIXED (`open · active · paused · done · lost`), CHECKed here.
-- No data is moved by this file: the backfill is the `projectLifecycleColumns`
-- conversion (conversions/manifest.ts), which needs the declarations seeded.

ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "status" text;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "status_category" text;
ALTER TABLE "entity_facets" ADD COLUMN IF NOT EXISTS "status_category" text;
ALTER TABLE "profile_properties" ADD COLUMN IF NOT EXISTS "is_lifecycle" boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entities_status_category_check') THEN
    ALTER TABLE "entities" ADD CONSTRAINT "entities_status_category_check"
      CHECK ("status_category" IS NULL OR "status_category" IN ('open','active','paused','done','lost'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_facets_status_category_check') THEN
    ALTER TABLE "entity_facets" ADD CONSTRAINT "entity_facets_status_category_check"
      CHECK ("status_category" IS NULL OR "status_category" IN ('open','active','paused','done','lost'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "profile_properties_one_lifecycle_uniq"
  ON "profile_properties" ("profile_id") WHERE "is_lifecycle";

CREATE INDEX IF NOT EXISTS "entities_profile_status_category_idx"
  ON "entities" ("profile_id", "status_category") WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "entity_facets_profile_status_category_idx"
  ON "entity_facets" ("profile_id", "status_category") WHERE "deleted_at" IS NULL;
