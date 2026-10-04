-- 0294 — pod-local account recovery codes (account-recovery P1, 2026-10-04).
--
-- One-time look-up secrets that get a person back into THIS pod's account
-- without the Control Plane, the courier, or SSH. Only a scrypt hash is
-- stored; the plaintext is shown once and never persisted or logged.
-- One batch per user (a regenerate replaces it in one transaction);
-- `used_at` NULL = unused, set atomically at redeem.
--
-- Numbered 0294, not 0293: 0293 is left free for the concurrent backup-engine
-- wave (`backup_runs`), so the two branches cannot collide on a number.
CREATE TABLE IF NOT EXISTS "account_recovery_codes" (
  "id"         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    text        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash"  text        NOT NULL,
  "batch_id"   uuid        NOT NULL,
  "used_at"    timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "account_recovery_codes_user_idx"
  ON "account_recovery_codes" ("user_id");
