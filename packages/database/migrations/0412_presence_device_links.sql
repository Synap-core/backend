-- 0412 — Proof of presence, "Add this device" (founder decision of 9 Nov 2026,
-- session 84c74a23). A person who holds a proof factor could not bring a NEW
-- device in: pod admin on a phone proves only with a passkey that browser
-- reaches, and Relay's device-key enrolment needs a proof made ON the phone.
-- Now the new device ASKS, a device the person already uses APPROVES it
-- (number matching plus a proof from an existing factor), and the new device
-- then adds its own passkey or device key with no further proof.
--
--  - `presence_device_links`: one request per new device. `requester_session`
--    binds it to the session that asked (`kratos:<id>` or `device:<id>`): only
--    that session reads its status or redeems the approval. `match_number` is
--    the two digits the new device shows; `choices` the three the approving
--    device offers (the match among them). `key_fingerprint` names the device
--    key a `device_key` request may enrol. One pending request per person.
--  - `presence_challenges.grant_session`: the session a `passkey_change` grant
--    may be redeemed by. Before it, any signed-in session of the person could
--    redeem a grant within 5 minutes; a grant with no session is no longer
--    redeemable.
--
-- No foreign key to users, as 0398. Re-runnable: IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS "presence_device_links" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"           text        NOT NULL,
  "kind"              text        NOT NULL,
  "label"             text        NOT NULL,
  "requester_session" text        NOT NULL,
  "key_fingerprint"   text,
  "match_number"      text        NOT NULL,
  "choices"           text[]      NOT NULL,
  "status"            text        NOT NULL DEFAULT 'pending',
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "expires_at"        timestamptz NOT NULL,
  "decided_at"        timestamptz,
  "approved_method"   text,
  "redeemed_at"       timestamptz,
  CONSTRAINT "presence_device_links_kind_check"
    CHECK ("kind" IN ('passkey', 'device_key')),
  CONSTRAINT "presence_device_links_status_check"
    CHECK ("status" IN ('pending', 'approved', 'declined', 'redeemed', 'replaced'))
);

CREATE INDEX IF NOT EXISTS "presence_device_links_user_idx"
  ON "presence_device_links" ("user_id", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "presence_device_links_one_pending"
  ON "presence_device_links" ("user_id") WHERE "status" = 'pending';

ALTER TABLE "presence_challenges"
  ADD COLUMN IF NOT EXISTS "grant_session" text;
