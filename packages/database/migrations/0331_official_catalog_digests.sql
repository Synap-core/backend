-- 0331_official_catalog_digests
--
-- Synap's catalog, signed. The Control
-- Plane serves a signed index of package digests beside its catalog
-- endpoints; the catalog sync verifies it (offline root key -> keys statement
-- -> online catalog key -> index) and keeps here what the last VERIFIED index
-- lists: one row per (kind, slug), with the content digest every official
-- definition is checked against before it installs or converges.
--
-- Replaced whole on every verified index; never wiped when a sync fails (the
-- last verified copy stays). Read by primary key, or by slug for the tier
-- check, so no further index.

CREATE TABLE IF NOT EXISTS "official_catalog_digests" (
  "kind" text NOT NULL,
  "slug" text NOT NULL,
  "version" text NOT NULL,
  "content_hash" text NOT NULL,
  "required_tier" text,
  "synced_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("kind", "slug")
);
