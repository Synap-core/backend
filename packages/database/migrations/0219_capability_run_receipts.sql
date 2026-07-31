-- Migration: 0219_capability_run_receipts.sql
--
-- Data-integrity: at-most-once receipt for a DIRECT-run WRITE/external capability.
--
-- The proposal path already closes the double-send gap via
-- `dispatchExternalOnce` (an atomic claim on `proposals.external_dispatched_at`,
-- migration 0209). But `executeCapability`'s DIRECT-run path (`decision === "run"`
-- — owner-bypass or governance-auto-granted, NO proposal) fires an irreversible
-- external effect (email / message / provider write) with NO persisted receipt.
-- A client-perceived-failure RETRY re-runs the same call → a SECOND real send.
--
-- This table is the DIRECT path's analog of `external_dispatched_at`: before the
-- external effect the door CAS-claims a row keyed on `(idempotency_key,
-- dedup_bucket)` via INSERT … ON CONFLICT DO NOTHING. The loser of the race (a
-- retry, or a concurrent identical call) finds the prior row and REPLAYS its
-- stored `result` instead of re-running the effect. A definite not-delivered
-- outcome DELETES the claim so a retry re-runs; an ambiguous throw KEEPS the
-- claim (never a double-send) — the same hybrid policy dispatchExternalOnce uses.
--
-- WINDOWED (mirrors 0216 knowledge_facts): `dedup_bucket` = floor(epoch(now)/600)
-- as a column DEFAULT — a ~10-minute window so a retry collapses onto the claim
-- while a genuinely repeated identical run in a later bucket is NOT blocked. The
-- unique index on (idempotency_key, dedup_bucket) makes a same-bucket duplicate a
-- DB-level impossibility: the losing concurrent INSERT hits SQLSTATE 23505 (or is
-- absorbed by ON CONFLICT DO NOTHING) rather than landing a second claim.
--
-- READ-only capability verbs never write a receipt (no double-send risk).
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

CREATE TABLE IF NOT EXISTS "capability_run_receipts" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "idempotency_key" text NOT NULL,
  "dedup_bucket"    bigint DEFAULT floor(extract(epoch FROM now()) / 600),
  "user_id"         text NOT NULL,
  "workspace_id"    uuid,
  "skill_id"        uuid NOT NULL,
  "verb_id"         text,
  "status"          text NOT NULL DEFAULT 'claimed',
  "result"          jsonb,
  "correlation_id"  uuid,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "completed_at"    timestamptz
);

-- Idempotent column guards (pre-existing table catch-up).
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "dedup_bucket" bigint DEFAULT floor(extract(epoch FROM now()) / 600);
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "skill_id" uuid;
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "verb_id" text;
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'claimed';
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "result" jsonb;
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "correlation_id" uuid;
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "created_at" timestamptz DEFAULT now();
ALTER TABLE "capability_run_receipts" ADD COLUMN IF NOT EXISTS "completed_at" timestamptz;

-- The CAS claim's uniqueness: one live claim per (key, ~10-min bucket).
CREATE UNIQUE INDEX IF NOT EXISTS "capability_run_receipts_key_bucket_uq"
  ON "capability_run_receipts" ("idempotency_key", "dedup_bucket");

CREATE INDEX IF NOT EXISTS "capability_run_receipts_user_id_idx"
  ON "capability_run_receipts" ("user_id");
