-- 0164_workspace_members_unique.sql
--
-- `workspace_members` had NO unique constraint on (workspace_id, user_id).
-- Code that upserts membership via onConflictDoNothing() (e.g. the Hub
-- `/workspaces/enroll-agent` route) therefore did NOT actually dedup and could
-- insert duplicate member rows for the same (workspace, user). This migration
-- removes any existing duplicates, then adds the unique index so future upserts
-- dedup correctly. Idempotent + safe to re-run.

-- 1. Remove duplicate membership rows, keeping exactly ONE per
--    (workspace_id, user_id): the most-privileged role, tie-broken by the
--    earliest join, then id (deterministic).
DELETE FROM "workspace_members" wm
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id, user_id
           ORDER BY
             CASE role
               WHEN 'owner'  THEN 0
               WHEN 'admin'  THEN 1
               WHEN 'editor' THEN 2
               WHEN 'viewer' THEN 3
               ELSE 4
             END,
             joined_at ASC,
             id ASC
         ) AS rn
  FROM "workspace_members"
) dup
WHERE wm.id = dup.id AND dup.rn > 1;

-- 2. Enforce one membership row per (workspace_id, user_id) going forward.
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_members_workspace_user_unique"
  ON "workspace_members" ("workspace_id", "user_id");
