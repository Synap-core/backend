-- 0276 — exposure substrate (Sites W2, sub-step S1: schema only).
--
-- Additive + idempotent: every statement is IF NOT EXISTS / IF EXISTS, guarded
-- by pg_constraint, or CREATE OR REPLACE, so a second run is a no-op. No door
-- writes these columns yet (W2 S2/S3 do); this wave only makes them exist.
--
-- 1. resource_shares becomes the per-record LINK + PUBLICATION table.
--    Guests are NOT rows here: they are project_members(role='guest').
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "audience" text;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "anchor_project_id" uuid;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "state" text;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "published_by" text;
-- The PINNED revision: the ROW ID of a `document_versions` checkpoint of the
-- shared entity's document (a row that stores content, so it can be served).
-- Pinned by id, not by version number: (document_id, version) is NOT unique
-- (baseline document_versions_version_idx), so a number may name several rows.
-- It is NOT `documents.content_revision` (0275): that counter moves on every
-- autosave and names no stored content. OPTIONAL: an entity without a document,
-- and a view, have nothing to pin (a CHECK cannot see whether an entity has a
-- document). FK ON DELETE SET NULL + the trigger in §3: a LIVE PUBLISHED row
-- can never lose its pin (the SET NULL is refused, so the version delete fails);
-- a draft or revoked row just drops it.
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "published_document_version_id" uuid;
-- The SNAPSHOT (founder decision): the allowlisted property values, copied at
-- publish time as a JSON object { "<property key>": <value>, … }. The public
-- projection reads ONLY this object, never the live record, so a later edit to
-- the record cannot publish itself. Re-publishing writes a new snapshot.
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "published_properties" jsonb;
-- Display-only prefix of a link token (the token itself is stored hashed only).
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "token_prefix" text;
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "revoked_by" text;

-- 2. Neutralise every pre-0276 row. Its only writer (routers/sharing.ts) was
--    deleted in W1; it stored PLAINTEXT tokens. Revoked forever, plaintext and
--    hash dropped (so the unique hash index below cannot collide). Expected row
--    count on live pods: 0.
--    Re-runnable: a post-0276 row always has audience set and public_token NULL,
--    so a second run matches nothing.
UPDATE "resource_shares"
   SET "public_token" = NULL,
       "token_hash"   = NULL,
       "revoked_at"   = COALESCE("revoked_at", now()),
       "audience"     = COALESCE("audience",
                          CASE WHEN "visibility" = 'public' THEN 'public' ELSE 'link' END),
       "state"        = COALESCE("state", 'draft'),
       "updated_at"   = now()
 WHERE "audience" IS NULL OR "public_token" IS NOT NULL;

ALTER TABLE "resource_shares" ALTER COLUMN "audience" SET NOT NULL;
ALTER TABLE "resource_shares" ALTER COLUMN "state" SET DEFAULT 'draft';
ALTER TABLE "resource_shares" ALTER COLUMN "state" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_audience_check') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_audience_check"
      CHECK ("audience" IN ('link', 'public'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_state_check') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_state_check"
      CHECK ("state" IN ('draft', 'published'));
  END IF;
  -- A live LINK is anchored on a project; a live PUBLIC row is not. Revoked
  -- legacy rows are exempt (they carry no anchor). Both operands are NOT NULL
  -- booleans, so the CHECK can never pass on UNKNOWN.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_anchor_check') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_anchor_check"
      CHECK ("revoked_at" IS NOT NULL
             OR (("audience" = 'link') = ("anchor_project_id" IS NOT NULL)));
  END IF;
  -- Only a PUBLIC row can be published, and a published row carries its
  -- publication time AND its snapshot object. Every operand is a NOT NULL
  -- boolean (`IS NOT DISTINCT FROM` turns a NULL jsonb_typeof into false), so a
  -- published row without a snapshot can never pass on UNKNOWN.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_published_check') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_published_check"
      CHECK ("state" = 'draft'
             OR ("audience" = 'public'
                 AND "published_at" IS NOT NULL
                 AND jsonb_typeof("published_properties") IS NOT DISTINCT FROM 'object'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_anchor_project_id_fkey') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_anchor_project_id_fkey"
      FOREIGN KEY ("anchor_project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_published_document_version_id_fkey') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_published_document_version_id_fkey"
      FOREIGN KEY ("published_document_version_id") REFERENCES "document_versions"("id") ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_workspace_id_fkey') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_workspace_id_fkey"
      FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
  END IF;
END $$;

-- One indexed hash lookup (never a table scan); one LIVE link per
-- (resource, anchor); one LIVE publication per resource.
CREATE UNIQUE INDEX IF NOT EXISTS "resource_shares_token_hash_uidx"
  ON "resource_shares" ("token_hash") WHERE "token_hash" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "resource_shares_live_link_uidx"
  ON "resource_shares" ("resource_type", "resource_id", "anchor_project_id")
  WHERE "audience" = 'link' AND "revoked_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "resource_shares_live_public_uidx"
  ON "resource_shares" ("resource_type", "resource_id")
  WHERE "audience" = 'public' AND "revoked_at" IS NULL;
CREATE INDEX IF NOT EXISTS "resource_shares_resource_idx"
  ON "resource_shares" ("resource_type", "resource_id");
CREATE INDEX IF NOT EXISTS "resource_shares_workspace_id_idx"
  ON "resource_shares" ("workspace_id");
CREATE INDEX IF NOT EXISTS "resource_shares_anchor_project_id_idx"
  ON "resource_shares" ("anchor_project_id");

-- 3. REVOKE IS PERMANENT (founder decision). Once revoked_at is set, the row's
--    grant-bearing and publication columns are frozen: nothing un-revokes, and a
--    revoked row cannot be re-pointed, re-tokened or re-published. Re-sharing
--    creates a NEW row. Precedent: 0169 (immutable column trigger).
--    The pin may only be CLEARED on a revoked row (that grants nothing), which
--    is what the FK's ON DELETE SET NULL does when its version is deleted.
--    The same trigger holds the PIN FLOOR: a live published row can never lose
--    its pin — FK referential actions run as UPDATEs and fire this trigger, so
--    deleting a version a live publication pins is refused (unpublish or revoke
--    first).
CREATE OR REPLACE FUNCTION "resource_shares_revoke_is_permanent"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."revoked_at" IS NOT NULL AND (
       NEW."revoked_at"                 IS DISTINCT FROM OLD."revoked_at"
    OR NEW."state"                      IS DISTINCT FROM OLD."state"
    OR NEW."token_hash"                 IS DISTINCT FROM OLD."token_hash"
    OR NEW."expires_at"                 IS DISTINCT FROM OLD."expires_at"
    OR NEW."audience"                   IS DISTINCT FROM OLD."audience"
    OR NEW."anchor_project_id"          IS DISTINCT FROM OLD."anchor_project_id"
    OR NEW."resource_id"                IS DISTINCT FROM OLD."resource_id"
    OR NEW."published_at"               IS DISTINCT FROM OLD."published_at"
    OR (NEW."published_document_version_id" IS DISTINCT FROM OLD."published_document_version_id"
        AND NEW."published_document_version_id" IS NOT NULL)
    OR NEW."published_properties"       IS DISTINCT FROM OLD."published_properties"
  ) THEN
    RAISE EXCEPTION 'resource_shares %: revocation is permanent', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."revoked_at" IS NULL
     AND NEW."state" = 'published'
     AND OLD."published_document_version_id" IS NOT NULL
     AND NEW."published_document_version_id" IS NULL THEN
    RAISE EXCEPTION 'resource_shares %: a live publication cannot lose its pinned document version', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "resource_shares_revoke_is_permanent" ON "resource_shares";
CREATE TRIGGER "resource_shares_revoke_is_permanent"
  BEFORE UPDATE ON "resource_shares"
  FOR EACH ROW EXECUTE FUNCTION "resource_shares_revoke_is_permanent"();

-- 4. VIEWS — explicit exposure marker, disjoint from the 0166 "pinned surface"
--    meaning of project_id: project_id + exposed_at NULL = pinned surface;
--    project_id + exposed_at set = shared with that project's members.
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "exposed_at" timestamp with time zone;
ALTER TABLE "views" ADD COLUMN IF NOT EXISTS "exposed_by" text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'views_exposed_requires_project') THEN
    ALTER TABLE "views" ADD CONSTRAINT "views_exposed_requires_project"
      CHECK ("exposed_at" IS NULL OR "project_id" IS NOT NULL);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "views_exposed_project_idx"
  ON "views" ("project_id") WHERE "exposed_at" IS NOT NULL;

-- 5. PROJECT MEMBERS — a guest is a project ROLE (`role = 'guest'`; the role
--    set is enforced in zod, no CHECK: existing rows may hold e.g. 'admin').
--    granted_via_share_id = provenance of a link-granted membership, captured at
--    redemption (it cannot be backfilled later).
ALTER TABLE "project_members" ADD COLUMN IF NOT EXISTS "granted_via_share_id" uuid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_members_granted_via_share_id_fkey') THEN
    ALTER TABLE "project_members" ADD CONSTRAINT "project_members_granted_via_share_id_fkey"
      FOREIGN KEY ("granted_via_share_id") REFERENCES "resource_shares"("id") ON DELETE SET NULL;
  END IF;
END $$;

-- 6. Index for the pod-participation predicate (workspace_members has only a
--    (workspace_id, user_id) unique index, which cannot serve a user_id-only
--    probe). The owner probe is already served by
--    idx_workspaces_owner_workspace_type (owner_id-leading; 0042 + baseline).
CREATE INDEX IF NOT EXISTS "idx_workspace_members_user_id"
  ON "workspace_members" ("user_id");
