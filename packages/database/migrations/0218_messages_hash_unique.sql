-- Migration: 0218_messages_hash_unique.sql
--
-- D5 idempotency: race-safe inbound claim via UNIQUE(messages.hash).
--
-- inbound-recorder (and a few other paths) use `messages.hash` as a content/
-- delivery fingerprint and SELECT-then-INSERT to drop duplicates. Without a
-- unique index two concurrent deliveries both see "no prior" and both insert —
-- double Discord agent-turn / double IS call under at-least-once delivery.
--
-- Dual-use of `hash` (document why GLOBAL unique is OK):
--   1) Tamper chain: `computeMessageHash(id, content, previousHash)` =
--      sha256(id + content + previousHash). Includes a UUID message id, so
--      every legitimate channel message has a distinct hash.
--   2) Inbound dedup: sha256(provider + ":" + idempotencySeed). Same seed is
--      intentionally the same hash so retries collapse.
-- Cross-domain collision between (1) and (2) is 2^-256. No partial index:
-- global unique is the claim for BOTH writers (a second insert of the same
-- inbound seed OR a second insert of the same tamper hash is a bug).
--
-- Pre-existing duplicates: keep the earliest row per hash (timestamp ASC, id
-- ASC) and delete later dups so the unique index can build. Chat-turn message
-- ids are not FKs to messages; reactions/links CASCADE/SET NULL as declared.
--
-- Additive, idempotent. Also added to 0000_baseline_schema.sql + Drizzle schema.

-- ── Dedupe existing dups (keep earliest) ─────────────────────────────────────
DELETE FROM "messages" m
USING (
  SELECT id
  FROM (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY hash
        ORDER BY "timestamp" ASC NULLS LAST, id ASC
      ) AS rn
    FROM "messages"
    WHERE hash IS NOT NULL
  ) ranked
  WHERE rn > 1
) dups
WHERE m.id = dups.id;

-- ── Race-safe claim ──────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "messages_hash_unique"
  ON "messages" ("hash");
