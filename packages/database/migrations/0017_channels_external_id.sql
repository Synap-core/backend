-- ============================================================================
-- 0017_channels_external_id.sql — External dedup keys for channels (threads)
-- ============================================================================
--
-- Adds (external_source, external_id) as a deterministic dedup key for
-- channels — used by sidecar pipelines (e.g. Open WebUI channel-sync) to
-- upsert a single thread per external conversation rather than relying on
-- an in-process cache that resets on container restart.
--
-- `external_source` already exists in the baseline schema (used historically
-- by EXTERNAL channel types like WhatsApp/Slack). This migration adds
-- `external_id` and a partial UNIQUE index across both columns. The partial
-- predicate (`WHERE external_id IS NOT NULL`) leaves rows with no external
-- identity unconstrained — most channels do not have one.
--
-- All statements are idempotent — safe to re-apply.
-- ============================================================================

ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "external_source" text;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "external_id"     text;

CREATE UNIQUE INDEX IF NOT EXISTS "channels_external_source_id_unique"
  ON "channels" ("external_source", "external_id")
  WHERE "external_id" IS NOT NULL;
