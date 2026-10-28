-- 0363: key requests (the CLI's door to a key) + grant_roles.uses (keys plan
-- 2026-10-27, Decisions 2 and 4).
--
-- key_requests: one row per key a CLI asked for (`POST /api/hub/keys/requests`,
-- `synap keys create --template <id>`). The computer never mints: its person
-- reviews the request on pod-admin, may narrow it (never widen it past the
-- `requested_*` ceiling), and approves; the CLI then collects the key ONCE
-- (`POST /api/hub/keys/requests/token`), minted at that moment as the person.
-- NO PLAINTEXT SECRET IS EVER STORED (the device-door rule, 0321): the request
-- code (the CLI's poll secret) is a sha256 hash, and the row holds only the
-- draft and, once collected, the minted key's id.
--
-- Lifecycle: pending → approved | denied → consumed. 15-minute TTL; a poll
-- faster than `poll_interval_seconds` answers `slow_down` (RFC 8628 §3.5).
--
-- grant_roles.uses: where a key made from a role is used (KEY_USES ids); NULL
-- = the role sets no door. Additive and nullable: the previous release neither
-- reads nor writes it, so a rollback onto this schema is safe.

CREATE TABLE IF NOT EXISTS "key_requests" (
  "id"                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_code_hash"          text NOT NULL,
  "status"                     text NOT NULL DEFAULT 'pending',
  "requester_user_id"          text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "requester_key_id"           uuid,
  "person_user_id"             text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "template_id"                text NOT NULL,
  "requested_name"             text NOT NULL,
  "requested_uses"             text[] NOT NULL DEFAULT '{}',
  "requested_permissions"      text[] NOT NULL DEFAULT '{}',
  "requested_workspace_ids"    uuid[],
  "requested_project_ids"      uuid[],
  "requested_entity_ids"       uuid[],
  "requested_expires_in_days"  integer,
  "requested_never_expires"    boolean NOT NULL DEFAULT false,
  "approved_by_user_id"        text REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at"                timestamptz,
  "approved_draft"             jsonb,
  "minted_key_id"              uuid,
  "poll_interval_seconds"      integer NOT NULL DEFAULT 5,
  "last_polled_at"             timestamptz,
  "consumed_at"                timestamptz,
  "expires_at"                 timestamptz NOT NULL,
  "created_at"                 timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'key_requests_status_check') THEN
    ALTER TABLE "key_requests" ADD CONSTRAINT "key_requests_status_check"
      CHECK ("status" IN ('pending', 'approved', 'denied', 'consumed'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "key_requests_request_code_hash_idx"
  ON "key_requests" ("request_code_hash");
CREATE INDEX IF NOT EXISTS "key_requests_requester_idx"
  ON "key_requests" ("requester_user_id");
CREATE INDEX IF NOT EXISTS "key_requests_person_idx"
  ON "key_requests" ("person_user_id");

ALTER TABLE "grant_roles" ADD COLUMN IF NOT EXISTS "uses" text[];
