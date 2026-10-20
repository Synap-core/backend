-- 0336 — site collections (collection door C1a: "a published project is a site").
--
-- Additive + idempotent: every statement is IF NOT EXISTS / IF EXISTS, guarded
-- by pg_constraint, or CREATE OR REPLACE, so a second run is a no-op. Fresh
-- installs also get the columns from 0000_baseline_schema.sql (no FK / CHECK /
-- index / trigger there: this file adds them on every database).
--
-- A SITE is one `resource_shares` row: resource_type = 'project',
-- audience = 'public', site_share_id NULL, addressed by its token. A record IN a
-- site is its own publication row (resource_type = 'entity', audience =
-- 'public') whose `site_share_id` names the site row (written from C1b on).
-- Every existing row has site_share_id NULL, so nothing changes for the
-- standalone (W3) publications.

-- 1. Columns.
-- The site this publication belongs to. NULL = a standalone publication or a
-- site row itself. A deleted site row takes its members with it.
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "site_share_id" uuid;
-- SiteConfigV1 (services/sharing/site-service.ts). Site rows only; written only
-- by the site doors; read fail-closed (unreadable = no collections).
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "site_config" jsonb;
-- A member row's stable public address: `p_` + 16 base62 chars, random, minted
-- once at the row's first insert and never changed (trigger below).
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "public_id" text;
-- A member row's normalized slug, or NULL (address by public_id only).
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "public_slug" text;
-- A member row's collection key (a profile slug).
ALTER TABLE "resource_shares" ADD COLUMN IF NOT EXISTS "published_collection" text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_site_share_id_fkey') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_site_share_id_fkey"
      FOREIGN KEY ("site_share_id") REFERENCES "resource_shares"("id") ON DELETE CASCADE;
  END IF;
  -- A member row is a public ENTITY publication with a collection and a public
  -- id. Every operand is a NOT NULL boolean once site_share_id is set.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_site_member_check') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_site_member_check"
      CHECK ("site_share_id" IS NULL
             OR ("audience" = 'public'
                 AND "resource_type" = 'entity'
                 AND "published_collection" IS NOT NULL
                 AND "public_id" IS NOT NULL));
  END IF;
  -- Only a site row (a public PROJECT row that is not itself a member) carries
  -- a site configuration.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_site_config_check') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_site_config_check"
      CHECK ("site_config" IS NULL
             OR ("resource_type" = 'project'
                 AND "audience" = 'public'
                 AND "site_share_id" IS NULL));
  END IF;
  -- A slug is lowercase ascii words joined by single hyphens, ≤ 96 chars. It
  -- has no `_`, so it can never match the public-id shape `p_…`.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'resource_shares_slug_check') THEN
    ALTER TABLE "resource_shares" ADD CONSTRAINT "resource_shares_slug_check"
      CHECK ("public_slug" IS NULL
             OR ("public_slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
                 AND length("public_slug") <= 96));
  END IF;
END $$;

-- 2. Indexes.
-- One live STANDALONE publication per resource. This replaces 0276's
-- `resource_shares_live_public_uidx`, which would forbid a record from being
-- both a standalone publication and a site member (or a member of two sites).
-- Site rows have site_share_id NULL, so this also keeps ONE live site per
-- project. Every existing row has site_share_id NULL, so the new index holds by
-- construction; it is created BEFORE the old one is dropped, so there is no
-- moment without the guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS "resource_shares_live_public_standalone_uidx"
  ON "resource_shares" ("resource_type", "resource_id")
  WHERE "audience" = 'public' AND "revoked_at" IS NULL AND "site_share_id" IS NULL;
DROP INDEX IF EXISTS "resource_shares_live_public_uidx";
-- One live member row per (site, record).
CREATE UNIQUE INDEX IF NOT EXISTS "resource_shares_live_site_member_uidx"
  ON "resource_shares" ("site_share_id", "resource_id")
  WHERE "site_share_id" IS NOT NULL AND "revoked_at" IS NULL;
-- A slug is unique among a site collection's live published members.
CREATE UNIQUE INDEX IF NOT EXISTS "resource_shares_site_slug_uidx"
  ON "resource_shares" ("site_share_id", "published_collection", "public_slug")
  WHERE "site_share_id" IS NOT NULL AND "revoked_at" IS NULL
    AND "state" = 'published' AND "public_slug" IS NOT NULL;
-- A public id names one row, ever.
CREATE UNIQUE INDEX IF NOT EXISTS "resource_shares_public_id_uidx"
  ON "resource_shares" ("public_id")
  WHERE "public_id" IS NOT NULL;
-- The collection list read (C1b): a site's live members of one collection,
-- newest first, stable on id.
CREATE INDEX IF NOT EXISTS "resource_shares_site_list_idx"
  ON "resource_shares" ("site_share_id", "published_collection", "published_at" DESC, "id")
  WHERE "site_share_id" IS NOT NULL AND "state" = 'published' AND "revoked_at" IS NULL;

-- 3. REVOKE IS PERMANENT, extended. Same function as 0276 plus:
--    - the five site columns are frozen on a revoked row (a revoked member
--      cannot be re-pointed at another site, re-slugged or re-collected; a
--      revoked site cannot be re-configured);
--    - `public_id` may go NULL → value ONCE and never change afterwards, on any
--      row, revoked or not: it is the stable public address.
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
    OR NEW."site_share_id"              IS DISTINCT FROM OLD."site_share_id"
    OR NEW."site_config"                IS DISTINCT FROM OLD."site_config"
    OR NEW."public_id"                  IS DISTINCT FROM OLD."public_id"
    OR NEW."public_slug"                IS DISTINCT FROM OLD."public_slug"
    OR NEW."published_collection"       IS DISTINCT FROM OLD."published_collection"
  ) THEN
    RAISE EXCEPTION 'resource_shares %: revocation is permanent', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."public_id" IS NOT NULL
     AND NEW."public_id" IS DISTINCT FROM OLD."public_id" THEN
    RAISE EXCEPTION 'resource_shares %: a public id never changes', OLD."id"
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
