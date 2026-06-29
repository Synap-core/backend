-- 0157_api_key_lookup_hash.sql
--
-- O(1) SHA-256 lookup path for API-key verification.
--
-- API keys are 256-bit RANDOM tokens (not passwords), so bcrypt's slowness
-- buys nothing for them — a plain sha256 is the industry-standard verifier
-- (GitHub/Stripe). This adds a nullable lookup-hash column so verification can
-- do an indexed equality lookup instead of bcrypt-comparing every
-- prefix-matching candidate (O(N) → O(1)).
--
-- LAZY DUAL-PATH: existing keys are bcrypt-only (sha256 can't be derived), so
-- the column stays NULL for them until the key is backfilled on its first
-- successful bcrypt verify. New keys store the hash at creation time.
--
-- Index is NON-UNIQUE: the column is nullable with many NULLs for un-migrated
-- keys, so a plain index avoids any NULL-collision concern.

ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "key_lookup_hash" text;

CREATE INDEX IF NOT EXISTS "api_keys_key_lookup_hash_idx"
  ON "api_keys" ("key_lookup_hash");
