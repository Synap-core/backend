-- 0448 — one sharing table for every object that has a home space (EXPAND).
--
-- `space_access (object_type, object_id, workspace_id, granted_by, granted_at)`
-- is the grant row that lets an object homed in one space be used in another.
-- Kinds (`profile`) first; the share door for playbooks and skills adds its
-- object types. It takes over from
-- `profile_workspace_access`, whose kind grants are copied here as `profile`
-- rows. Forward-only: the old table stays, and until the release that drops it
-- (its contract step) the two are kept equal in both directions for kinds, so
-- a previous release running on this schema (a rolled-back update) reads and
-- writes the same grants. The object id has no foreign key (it will name rows
-- of several tables): a delete trigger on the object table removes its grants.
-- Idempotent.

CREATE TABLE IF NOT EXISTS "space_access" (
  "object_type"  text NOT NULL,
  "object_id"    uuid NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "granted_by"   text,
  "granted_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "space_access_pkey" PRIMARY KEY ("object_type", "object_id", "workspace_id")
);
CREATE INDEX IF NOT EXISTS "space_access_workspace_idx" ON "space_access" ("workspace_id");

INSERT INTO "space_access" ("object_type", "object_id", "workspace_id", "granted_at")
SELECT 'profile', "profile_id", "workspace_id", "granted_at"
FROM "profile_workspace_access"
WHERE "workspace_id" IS NOT NULL
ON CONFLICT DO NOTHING;

