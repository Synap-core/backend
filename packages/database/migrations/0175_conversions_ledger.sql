-- 0175_conversions_ledger.sql
--
-- Kind + Facets Wave 3A — the `_conversions` ledger.
--
-- Mirrors `_migrations`' role, but for DATA operations rather than DDL. The
-- generic conversion engine (packages/database/src/conversions/) records one
-- row per applied op so a real run is idempotent: an op whose `op_key` is
-- already present (with `error IS NULL` and `dry_run = false`) is skipped on the
-- next run. Dry-run passes never write here.
--
-- `counts` holds the per-op tally the engine computed (entities converted,
-- facets created, views rewritten, …). `error` is NULL on success and carries
-- the failure message when an op aborts — a later successful retry UPSERTs the
-- row back to `error = NULL`.
--
-- Defensive + idempotent (IF NOT EXISTS guards). Also mirrored into
-- 0000_baseline_schema.sql so fresh pods have the table before the engine runs.

CREATE TABLE IF NOT EXISTS "_conversions" (
  "id"         serial      PRIMARY KEY,
  "op_key"     text        NOT NULL UNIQUE,
  "applied_at" timestamp with time zone NOT NULL DEFAULT now(),
  "dry_run"    boolean     NOT NULL DEFAULT false,
  "counts"     jsonb       NOT NULL DEFAULT '{}',
  "error"      text
);

-- Ensure all columns exist on pre-existing tables (idempotent guard).
ALTER TABLE "_conversions" ADD COLUMN IF NOT EXISTS "op_key" text;
ALTER TABLE "_conversions" ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone DEFAULT now();
ALTER TABLE "_conversions" ADD COLUMN IF NOT EXISTS "dry_run" boolean DEFAULT false;
ALTER TABLE "_conversions" ADD COLUMN IF NOT EXISTS "counts" jsonb DEFAULT '{}';
ALTER TABLE "_conversions" ADD COLUMN IF NOT EXISTS "error" text;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = '_conversions_op_key_key'
  ) THEN
    ALTER TABLE "_conversions" ADD CONSTRAINT "_conversions_op_key_key" UNIQUE ("op_key");
  END IF;
END $$;
