-- Migration 0040: Profile shared scope + profile_workspace_access join table
--
-- Adds "shared" as a valid profile scope value (between "system" and "workspace"),
-- and creates a join table that explicitly grants specific workspaces access to
-- shared profiles.
--
-- "shared" profiles are owned by one workspace but can be accessed from others
-- via profile_workspace_access rows. This allows flagship templates (CRM, etc.)
-- to define reusable entity types (company, contact) that survive workspace deletion
-- or can be shared across a multi-workspace pod.

-- 1. Allow "shared" in the scope check constraint (if one exists)
--    Profiles use a plain text column with no Postgres CHECK — this is a no-op DDL.
--    The enum validation lives in the application layer (Drizzle / Zod).
--    Keeping this comment for documentation purposes.

-- 2. Create the join table
CREATE TABLE IF NOT EXISTS "profile_workspace_access" (
  "profile_id"   uuid        NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
  "workspace_id" uuid        NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "granted_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("profile_id", "workspace_id")
);

CREATE INDEX IF NOT EXISTS "profile_workspace_access_workspace_idx"
  ON "profile_workspace_access" ("workspace_id");
