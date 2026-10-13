-- 0327: marketplace sources you choose (Pod Console D11). A row synced from a
-- third-party source (`source` = that source's id, never a URL) carries its
-- signed listing facts: where its definition lives and the digest it must
-- match, plus the publisher's own pages a showcase-only listing opens. NULL on
-- every row from the official catalog, whose definitions come from the Control
-- Plane's own endpoints exactly as before.

ALTER TABLE "cp_catalog_cache" ADD COLUMN IF NOT EXISTS "listing" jsonb;
