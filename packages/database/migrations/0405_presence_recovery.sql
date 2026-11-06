-- 0405 — Proof of presence, the recovery ladder (founder, 6 Nov 2026: a lost
-- only-passkey locked the founder out of every sensitive action under
-- `enforce`; finding 7bf25c2e). Three more ways to prove presence, and one
-- slow way back:
--
--  - `presence_totp_factors`: a person's 2FA app. The secret is an encrypted
--    field (`ENCRYPTED_COLUMNS`); `confirmed_at` is set once a first code
--    proved the app holds it; `last_used_step` is the last 30 s step a code
--    was accepted for, so a code is never accepted twice.
--  - `presence_proof_failures`: one row per wrong TYPED code (2FA app,
--    recovery code), so a person gets at most a few tries a quarter-hour.
--  - `presence_recovery_requests`: "I lost my passkey". Pending for 24 h,
--    cancellable from any of the person's sessions, then finished by the
--    person, which clears their factors. One pending request per person.
--  - `presence_disowned_passkeys`: the passkeys a finished recovery cleared.
--    Kratos v1.3.1 has no admin door that removes a passkey, so the pod stops
--    accepting them as a proof; they stay a sign-in method until the person
--    removes them in their passkey settings.
--
-- No foreign key to users, as 0398. Re-runnable: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "presence_totp_factors" (
  "id"             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        text        NOT NULL,
  "label"          text        NOT NULL,
  "secret"         text        NOT NULL,
  "confirmed_at"   timestamptz,
  "last_used_step" bigint,
  "revoked_at"     timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "presence_totp_factors_user_idx"
  ON "presence_totp_factors" ("user_id");

CREATE TABLE IF NOT EXISTS "presence_proof_failures" (
  "id"         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    text        NOT NULL,
  "method"     text        NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "presence_proof_failures_user_idx"
  ON "presence_proof_failures" ("user_id", "created_at");

CREATE TABLE IF NOT EXISTS "presence_recovery_requests" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      text        NOT NULL,
  "status"       text        NOT NULL DEFAULT 'pending',
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "matures_at"   timestamptz NOT NULL,
  "cancelled_at" timestamptz,
  "completed_at" timestamptz,
  CONSTRAINT "presence_recovery_requests_status_check"
    CHECK ("status" IN ('pending', 'cancelled', 'completed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "presence_recovery_requests_one_pending"
  ON "presence_recovery_requests" ("user_id") WHERE "status" = 'pending';

CREATE TABLE IF NOT EXISTS "presence_disowned_passkeys" (
  "user_id"             text        NOT NULL,
  "credential_id"       text        NOT NULL,
  "recovery_request_id" uuid        NOT NULL,
  "disowned_at"         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "credential_id")
);
