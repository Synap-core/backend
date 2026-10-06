-- 0307: grant roles — a person's reusable, named permission lists (2026-10-06).
--
-- A role is a TEMPLATE: minting a key from it copies its grant onto the key's
-- `grants` row and stamps `grants.role_id` as lineage. Editing a role never
-- widens an existing key. NULL id sets = no narrowing on that axis;
-- expires_in_days NULL = the role sets no lifetime (unless never_expires).
-- Not the profile "role" (facets) and not a workspace member role.
-- (0306 is reserved by a peer wave.) Idempotent.

CREATE TABLE IF NOT EXISTS "grant_roles" (
  "id"              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"         text        NOT NULL,
  "name"            text        NOT NULL,
  "description"     text        NOT NULL DEFAULT '',
  "permissions"     text[]      NOT NULL DEFAULT '{}'::text[],
  "workspace_ids"   uuid[],
  "project_ids"     uuid[],
  "entity_ids"      uuid[],
  "expires_in_days" integer,
  "never_expires"   boolean     NOT NULL DEFAULT false,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  "archived_at"     timestamptz
);
CREATE INDEX IF NOT EXISTS "grant_roles_user_idx" ON "grant_roles" ("user_id");

ALTER TABLE "grants" ADD COLUMN IF NOT EXISTS "role_id" uuid
  REFERENCES "grant_roles"("id") ON DELETE SET NULL;
