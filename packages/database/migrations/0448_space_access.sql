-- 0448 — one sharing table for every object that has a home space.
--
-- `profile_workspace_access` (a kind shared with other spaces) becomes
-- `space_access (object_type, object_id, workspace_id, granted_by, granted_at)`:
-- the grant row that lets an object homed in one space be used in another.
-- Existing rows are kind grants (`object_type = 'profile'`). The object id has
-- no foreign key (it names rows of several tables), so a trigger on each object
-- table removes the grants of a deleted row, as the old cascade did for kinds.
-- Idempotent: a fresh pod's baseline already creates `space_access`.

DO $$
BEGIN
  IF to_regclass('public.space_access') IS NULL
     AND to_regclass('public.profile_workspace_access') IS NOT NULL THEN
    ALTER TABLE "profile_workspace_access" RENAME TO "space_access";
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'space_access'
      AND column_name = 'profile_id'
  ) THEN
    ALTER TABLE "space_access" DROP CONSTRAINT IF EXISTS "profile_workspace_access_pkey";
    ALTER TABLE "space_access" DROP CONSTRAINT IF EXISTS "profile_workspace_access_profile_id_profiles_id_fk";
    ALTER TABLE "space_access" DROP CONSTRAINT IF EXISTS "profile_workspace_access_profile_id_fkey";
    ALTER TABLE "space_access" RENAME COLUMN "profile_id" TO "object_id";
  END IF;
END $$;

ALTER TABLE "space_access" ADD COLUMN IF NOT EXISTS "object_type" text NOT NULL DEFAULT 'profile';
ALTER TABLE "space_access" ALTER COLUMN "object_type" DROP DEFAULT;
ALTER TABLE "space_access" ADD COLUMN IF NOT EXISTS "granted_by" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'space_access_pkey'
  ) THEN
    ALTER TABLE "space_access"
      ADD CONSTRAINT "space_access_pkey" PRIMARY KEY ("object_type", "object_id", "workspace_id");
  END IF;
END $$;

ALTER INDEX IF EXISTS "profile_workspace_access_workspace_idx" RENAME TO "space_access_workspace_idx";
CREATE INDEX IF NOT EXISTS "space_access_workspace_idx" ON "space_access" ("workspace_id");

CREATE OR REPLACE FUNCTION synap_space_access_forget_object()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM "space_access"
  WHERE "object_type" = TG_ARGV[0] AND "object_id" = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_profiles_forget_space_access ON profiles;
CREATE TRIGGER trg_profiles_forget_space_access
  AFTER DELETE ON profiles
  FOR EACH ROW EXECUTE FUNCTION synap_space_access_forget_object('profile');

DROP TRIGGER IF EXISTS trg_playbooks_forget_space_access ON playbooks;
CREATE TRIGGER trg_playbooks_forget_space_access
  AFTER DELETE ON playbooks
  FOR EACH ROW EXECUTE FUNCTION synap_space_access_forget_object('playbook');

DROP TRIGGER IF EXISTS trg_skills_forget_space_access ON skills;
CREATE TRIGGER trg_skills_forget_space_access
  AFTER DELETE ON skills
  FOR EACH ROW EXECUTE FUNCTION synap_space_access_forget_object('skill');
