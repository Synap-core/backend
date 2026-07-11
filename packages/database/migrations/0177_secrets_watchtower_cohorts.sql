-- 0177_secrets_watchtower_cohorts.sql
--
-- Vault Watchtower BF-7 / BF-8: two write-time security columns on `secrets`.
--
-- Both are computed when the plaintext value is already in hand (create/update)
-- — NEVER by decrypting and scanning stored rows.
--
--   has_totp             — boolean, set to true when the structured plaintext
--                          carried a non-empty `totp`. Powers the Watchtower
--                          "N logins without 2FA" cohort.
--   password_fingerprint — HMAC-SHA256(VAULT_SERVER_KEY, normalize(password)) as
--                          hex. A keyed digest (NOT a bare hash — defeats an
--                          offline dictionary attack on the column) so two
--                          secrets can be compared for password reuse entirely
--                          server-side without ever re-holding plaintext.
--
-- Backfill: leave the default (has_totp=false, password_fingerprint=NULL).
-- Existing rows re-stamp themselves on their next edit, when the plaintext value
-- flows back through create/update.
--
-- STRICT migration rules: IF NOT EXISTS everywhere; also mirrored into
-- 0000_baseline_schema.sql and asserted in schema-coherence.ts.

ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "has_totp" boolean NOT NULL DEFAULT false;
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "password_fingerprint" text;

-- Supports the reused-password window scan:
--   count(*) OVER (PARTITION BY user_id, password_fingerprint) > 1
CREATE INDEX IF NOT EXISTS "idx_secrets_password_fingerprint"
  ON "secrets" ("user_id", "password_fingerprint");
