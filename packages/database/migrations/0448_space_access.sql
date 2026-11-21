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

-- Kind grants, mirrored both ways. An insert that meets its twin does nothing,
-- and an AFTER ROW trigger does not fire for a row not written, so the mirror
-- stops after one hop.
CREATE OR REPLACE FUNCTION synap_space_access_from_profile_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."workspace_id" IS NOT NULL THEN
      INSERT INTO "space_access" ("object_type", "object_id", "workspace_id", "granted_at")
      VALUES ('profile', NEW."profile_id", NEW."workspace_id", NEW."granted_at")
      ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;
  DELETE FROM "space_access"
  WHERE "object_type" = 'profile' AND "object_id" = OLD."profile_id"
    AND "workspace_id" = OLD."workspace_id";
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION synap_profile_grant_from_space_access()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."object_type" = 'profile' THEN
      INSERT INTO "profile_workspace_access" ("profile_id", "workspace_id", "granted_at")
      SELECT NEW."object_id", NEW."workspace_id", NEW."granted_at"
      WHERE EXISTS (SELECT 1 FROM "profiles" WHERE "id" = NEW."object_id")
      ON CONFLICT DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."object_type" = 'profile' THEN
    DELETE FROM "profile_workspace_access"
    WHERE "profile_id" = OLD."object_id" AND "workspace_id" = OLD."workspace_id";
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_workspace_access_mirror ON profile_workspace_access;
CREATE TRIGGER trg_profile_workspace_access_mirror
  AFTER INSERT OR DELETE ON profile_workspace_access
  FOR EACH ROW EXECUTE FUNCTION synap_space_access_from_profile_grant();

DROP TRIGGER IF EXISTS trg_space_access_mirror ON space_access;
CREATE TRIGGER trg_space_access_mirror
  AFTER INSERT OR DELETE ON space_access
  FOR EACH ROW EXECUTE FUNCTION synap_profile_grant_from_space_access();

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
