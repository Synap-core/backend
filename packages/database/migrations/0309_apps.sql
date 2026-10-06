-- 0309: apps — a developer's application identity (App Connect v1, 2026-10-06).
--
-- An Application is the OBJECT a developer registers; `public_id` (`app_<uuid>`)
-- is the app's stable id AND the `client_id` its grant carries (the grants table
-- already has the `client_id` column, 0305). Requests the app ASKED for live in
-- `approved_requests` — set only by the `app/connect` approval executor, never
-- at register time. The bearer is an API key (api_keys, unchanged). Idempotent.

CREATE TABLE IF NOT EXISTS "apps" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_user_id"     text        NOT NULL,
  "public_id"         text        NOT NULL UNIQUE,
  "name"              text        NOT NULL,
  "description"       text,
  "logo_url"          text,
  "mode"              text        NOT NULL DEFAULT 'specific',
  "approved_requests" jsonb,
  "metadata"          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "last_used_at"      timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "revoked_at"        timestamptz
);

-- One app per (owner, name): the register door is idempotent by owner+name.
CREATE UNIQUE INDEX IF NOT EXISTS "apps_owner_name_unique"
  ON "apps" ("owner_user_id", "name");
CREATE INDEX IF NOT EXISTS "apps_owner_idx" ON "apps" ("owner_user_id");
