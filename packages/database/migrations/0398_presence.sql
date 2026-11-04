-- 0398 — Proof of presence (W3, plan "one way to connect an AI to Synap",
-- founder decision of 4 Nov 2026). A sensitive approval needs a fresh
-- signature over a pod challenge that names ONE proposal: a passkey (user
-- verification) or a device key behind a biometric. Challenges are answered
-- once, within 2 min; device keys store the PUBLIC key only.
--
-- Re-runnable: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "presence_challenges" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       text        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "subject"       text        NOT NULL,
  "nonce"         text        NOT NULL,
  "expires_at"    timestamptz NOT NULL,
  "consumed_at"   timestamptz,
  "method"        text,
  "device_key_id" uuid,
  "created_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "presence_challenges_user_subject_idx"
  ON "presence_challenges" ("user_id", "subject");

CREATE TABLE IF NOT EXISTS "presence_device_keys" (
  "id"           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      text        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "label"        text        NOT NULL,
  "public_key"   text        NOT NULL,
  "last_used_at" timestamptz,
  "revoked_at"   timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "presence_device_keys_user_idx"
  ON "presence_device_keys" ("user_id");
