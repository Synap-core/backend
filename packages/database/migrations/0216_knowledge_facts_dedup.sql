-- Migration: 0216_knowledge_facts_dedup.sql
--
-- knowledge_facts race fix (mirrors 0208's fix for `proposals`).
--
-- `rememberFact`'s idempotency guard (remember-fact.ts) is a read-then-write:
-- it SELECTs for a prior matching row, then inserts if none was found, with no
-- DB-level enforcement in between. Two close concurrent calls for the
-- identical fact both see "no prior" and both insert — a confirmed live
-- duplicate ("[DOGFOOD TEST] remember_fact idempotency guard").
--
-- This adds:
--   - `fact_hash` — a stored sha256 (pgcrypto) of the exact `fact` text,
--     mirroring the guard's exact-text `eq(knowledgeFacts.fact, fact)` match.
--     Hashing (not indexing `fact` directly) avoids the btree row-size limit
--     on an unbounded `text` column.
--   - `dedup_bucket` — a stored floor(epoch(created_at) / 600), matching the
--     guard's 600s window (`idempotencyWindowSeconds()`'s default). NOT a
--     permanent uniqueness constraint: the bucket rolls forward every 10
--     minutes, so a fact genuinely restated later is never blocked — same
--     semantics the app-level guard already promised for the non-race case.
--   - a partial-free unique index on (user_id, fact_hash, dedup_bucket) that
--     makes a same-bucket duplicate a DB-level impossibility: the losing
--     concurrent INSERT hits SQLSTATE 23505 instead of landing a duplicate
--     row. remember-fact.ts catches 23505 and returns the winning row
--     (mirrors `insertPendingProposal`'s 23505 recovery for proposals).
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

ALTER TABLE "knowledge_facts"
  ADD COLUMN IF NOT EXISTS "fact_hash" text
  GENERATED ALWAYS AS (encode(digest(fact, 'sha256'), 'hex')) STORED;

ALTER TABLE "knowledge_facts"
  ADD COLUMN IF NOT EXISTS "dedup_bucket" bigint
  GENERATED ALWAYS AS (floor(extract(epoch FROM created_at) / 600)) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_facts_dedup_uq"
  ON "knowledge_facts" ("user_id", "fact_hash", "dedup_bucket");
