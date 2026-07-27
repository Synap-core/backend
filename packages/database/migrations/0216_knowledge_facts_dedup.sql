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
--   - `dedup_bucket` — floor(epoch(now) / 600) applied as a column DEFAULT (NOT a
--     generated column): `extract(epoch FROM <timestamptz>)` is STABLE, not
--     IMMUTABLE, so it CANNOT back a GENERATED ALWAYS column (Postgres 42P17
--     "generation expression is not immutable"). A column DEFAULT, by contrast,
--     is evaluated at INSERT time and may be non-immutable — so the same 600s
--     window is applied via DEFAULT. It matches the guard's window
--     (`idempotencyWindowSeconds()`'s default): the bucket rolls forward every 10
--     minutes, so a fact genuinely restated later is never blocked.
--   - a unique index on (user_id, fact_hash, dedup_bucket) that makes a same-bucket
--     duplicate a DB-level impossibility: the losing concurrent INSERT hits
--     SQLSTATE 23505 instead of landing a duplicate row. remember-fact.ts catches
--     23505 and returns the winning row (mirrors `insertPendingProposal`'s 23505
--     recovery for proposals).
--
-- Pre-existing rows: `dedup_bucket` is added WITHOUT a default backfill, so they
-- stay NULL. NULLs are DISTINCT in a unique index — so the index builds cleanly
-- over any pre-existing duplicate facts (no destructive de-dupe needed); only NEW
-- same-bucket writes are deduped.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + schema-coherence.ts.

ALTER TABLE "knowledge_facts"
  ADD COLUMN IF NOT EXISTS "fact_hash" text
  GENERATED ALWAYS AS (encode(digest(fact, 'sha256'), 'hex')) STORED;

-- ADD without a default first (existing rows -> NULL, no backfill/rewrite), THEN
-- set the default so it applies only to future inserts. (Adding the column WITH a
-- default would backfill every existing row to the same current bucket and make
-- pre-existing duplicates collide when the unique index is built.)
ALTER TABLE "knowledge_facts"
  ADD COLUMN IF NOT EXISTS "dedup_bucket" bigint;

ALTER TABLE "knowledge_facts"
  ALTER COLUMN "dedup_bucket" SET DEFAULT floor(extract(epoch FROM now()) / 600);

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_facts_dedup_uq"
  ON "knowledge_facts" ("user_id", "fact_hash", "dedup_bucket");
