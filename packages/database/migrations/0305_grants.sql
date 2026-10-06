-- 0305: grants — what ONE credential may touch (W1, 2026-10-06).
--
-- The API key stays the bearer; a grant bounds it. Effective access is
-- grant ∩ the human floor. A key with no active grant keeps the legacy
-- behaviour (scopes + human floor). NULL id sets = no narrowing on that axis;
-- NULL expires_at = never (explicit; the default is 90 days at mint).
-- Design: CONNECT-RESEARCH/13-w1-grants-design-2026-10-06.md. Idempotent.

CREATE TABLE IF NOT EXISTS "grants" (
  "id"                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "api_key_id"        uuid        NOT NULL REFERENCES "api_keys"("id") ON DELETE CASCADE,
  "principal_user_id" text        NOT NULL,
  "on_behalf_of"      text        NOT NULL,
  "permissions"       text[]      NOT NULL DEFAULT '{}'::text[],
  "workspace_ids"     uuid[],
  "project_ids"       uuid[],
  "entity_ids"        uuid[],
  "expires_at"        timestamptz,
  "label"             text,
  "client_id"         text,
  "created_by"        text        NOT NULL,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "revoked_at"        timestamptz,
  "revoked_by"        text
);
CREATE INDEX IF NOT EXISTS "grants_api_key_idx" ON "grants" ("api_key_id");
CREATE INDEX IF NOT EXISTS "grants_on_behalf_of_idx" ON "grants" ("on_behalf_of");
